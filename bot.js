const TelegramBot = require('node-telegram-bot-api');
const { Client } = require('pg');

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

db.connect().then(() => {
    console.log('✅ Connected to PostgreSQL database');
    return db.query(`
        CREATE TABLE IF NOT EXISTS channels (
            id TEXT PRIMARY KEY,
            title TEXT
        );
    `);
}).catch(err => console.error('Database connection error', err));

const userState = {};

// Auto-detect when bot is added/removed from a channel
bot.on('my_chat_member', async (update) => {
    const chat = update.chat;
    const newStatus = update.new_chat_member.status;

    if (chat.type === 'channel' && (newStatus === 'administrator' || newStatus === 'member')) {
        try {
            const res = await db.query('SELECT * FROM channels WHERE id = $1', [chat.id.toString()]);
            if (res.rows.length === 0) {
                await db.query('INSERT INTO channels (id, title) VALUES ($1, $2)', [chat.id.toString(), chat.title]);
                console.log(`✅ Channel added: ${chat.title} (${chat.id})`);
            }
        } catch (e) {
            console.error('Error auto-adding channel:', e);
        }
    }

    if (chat.type === 'channel' && newStatus === 'left') {
        try {
            await db.query('DELETE FROM channels WHERE id = $1', [chat.id.toString()]);
            console.log(`❌ Channel removed: ${chat.title} (${chat.id})`);
        } catch (e) {
            console.error('Error auto-removing channel:', e);
        }
    }
});

// Show menu
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (msg.chat.type !== 'private') {
        bot.sendMessage(chatId, 'Please use this bot in a private chat.');
        return;
    }

    userState[chatId] = { step: 'menu' };
    const welcomeMessage = "Welcome TashanWIN\nXFTEAM\nhttps://t.me/TASHANWINXFTEAM";

    bot.sendMessage(chatId, welcomeMessage, {
        reply_markup: {
            keyboard: [
                [{ text: 'Create New Post' }],
                [{ text: 'View My Channels' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        }
    });
});

// Create new post
bot.onText(/Create New Post/, async (msg) => {
    const chatId = msg.chat.id;
    if (msg.chat.type !== 'private') return;

    const res = await db.query('SELECT * FROM channels');
    if (res.rows.length === 0) {
        bot.sendMessage(chatId, 'You have not added this bot to any channels yet. Please add me as admin in your channels first.');
    } else {
        userState[chatId] = { step: 'collecting_content', content: [] };
        bot.sendMessage(chatId, 'Please send the content you want to post (text, photos, videos, stickers, or GIFs). Type /done when finished.');
    }
});

// View channels
bot.onText(/View My Channels/, async (msg) => {
    const chatId = msg.chat.id;
    if (msg.chat.type !== 'private') return;

    const res = await db.query('SELECT * FROM channels');
    if (res.rows.length === 0) {
        bot.sendMessage(chatId, 'You have not added this bot to any channels yet.');
    } else {
        let channelList = "Here are the registered channels:\n\n";
        res.rows.forEach(row => {
            channelList += `${row.title} (${row.id})\n`;
        });
        bot.sendMessage(chatId, channelList);
    }
});

// Finish post
bot.onText(/\/done/, (msg) => {
    const chatId = msg.chat.id;
    if (msg.chat.type !== 'private' || !userState[chatId] || userState[chatId].step !== 'collecting_content') {
        bot.sendMessage(chatId, 'There is nothing to post. Please use "Create New Post" first.');
        return;
    }

    const content = userState[chatId].content;
    if (content.length === 0) {
        bot.sendMessage(chatId, 'No content was sent. Post canceled.');
        userState[chatId] = { step: 'menu' };
        return;
    }

    bot.sendMessage(chatId, 'Okay, sending your post to all channels...');

    db.query('SELECT * FROM channels', async (err, res) => {
        if (err) {
            console.error(err);
            bot.sendMessage(chatId, 'Error while retrieving channel list.');
            return;
        }

        if (res.rows.length === 0) {
            bot.sendMessage(chatId, 'No channels are registered. Post canceled.');
            userState[chatId] = { step: 'menu' };
            return;
        }

        for (const row of res.rows) {
            try {
                for (const item of content) {
                    if (item.type === 'text') {
                        await bot.sendMessage(row.id, item.value);
                    } else if (item.type === 'photo') {
                        await bot.sendPhoto(row.id, item.value, { caption: item.caption });
                    } else if (item.type === 'video') {
                        await bot.sendVideo(row.id, item.value, { caption: item.caption });
                    } else if (item.type === 'animation') {
                        await bot.sendAnimation(row.id, item.value);
                    } else if (item.type === 'sticker') {
                        await bot.sendSticker(row.id, item.value);
                    }
                }
                console.log(`✅ Sent to channel ${row.id}`);
            } catch (e) {
                console.error(`Failed to send to channel ${row.id}: ${e.message}`);
                if (e.message.includes('chat not found')) {
                    await db.query('DELETE FROM channels WHERE id = $1', [row.id]);
                    console.log(`Removed channel ${row.id} from database`);
                }
            }
        }

        bot.sendMessage(chatId, 'Your post has been successfully sent to all channels!');
        userState[chatId] = { step: 'menu' };
    });
});

// Collect content
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (msg.chat.type !== 'private') return;

    if (userState[chatId] && userState[chatId].step === 'collecting_content') {
        const { content } = userState[chatId];
        let newContent = {};

        if (msg.text && !msg.photo && !msg.video && !msg.animation && !msg.sticker) {
            if (msg.text.toLowerCase() === '/done') return;
            newContent = { type: 'text', value: msg.text };
        } else if (msg.photo) {
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            newContent = { type: 'photo', value: fileId, caption: msg.caption };
        } else if (msg.video) {
            const fileId = msg.video.file_id;
            newContent = { type: 'video', value: fileId, caption: msg.caption };
        } else if (msg.animation) {
            const fileId = msg.animation.file_id;
            newContent = { type: 'animation', value: fileId };
        } else if (msg.sticker) {
            const fileId = msg.sticker.file_id;
            newContent = { type: 'sticker', value: fileId };
        }

        if (Object.keys(newContent).length > 0) {
            content.push(newContent);
            bot.sendMessage(chatId, 'Content received. Send more content or type /done to post.');
        }
    }
});

console.log('🚀 Bot is running...');
