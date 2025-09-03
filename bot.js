const TelegramBot = require('node-telegram-bot-api');
const { Client } = require('pg');

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

db.connect()
    .then(() => {
        console.log('Connected to PostgreSQL database');
        return db.query(`
            CREATE TABLE IF NOT EXISTS channels (
                id TEXT PRIMARY KEY,
                title TEXT
            );
        `);
    })
    .catch(err => console.error('Database connection error:', err));

const userState = {};
let botId;

// Get bot ID once
bot.getMe().then(info => {
    botId = info.id;
    console.log(`Bot started as @${info.username} (ID: ${botId})`);
});

async function isBotAdmin(chatId) {
    try {
        const member = await bot.getChatMember(chatId, botId);
        return member.status === 'administrator' || member.status === 'creator';
    } catch (e) {
        return false;
    }
}

function sendMainMenu(chatId) {
    const welcomeMessage = "Welcome to the Broadcast Bot!\n\n" +
        "You can add me as admin to your channels, register them, and then create posts that I will send to all registered channels.";
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
}

bot.onText(/\/start/, (msg) => {
    if (msg.chat.type !== 'private') {
        bot.sendMessage(msg.chat.id, 'Please use this bot in a private chat.');
        return;
    }
    userState[msg.chat.id] = { step: 'menu' };
    sendMainMenu(msg.chat.id);
});

bot.onText(/\/register|\/addchannel/, async (msg) => {
    const chatId = msg.chat.id;
    if (msg.chat.type === 'private') {
        bot.sendMessage(chatId, 'This command must be used inside a channel where I am an admin.');
        return;
    }

    const botIsAdmin = await isBotAdmin(chatId);
    if (!botIsAdmin) {
        bot.sendMessage(chatId, 'I must be an administrator in this channel to register it.');
        return;
    }

    try {
        const res = await db.query('SELECT * FROM channels WHERE id = $1', [chatId]);
        if (res.rows.length === 0) {
            await db.query('INSERT INTO channels (id, title) VALUES ($1, $2)', [chatId, msg.chat.title]);
            bot.sendMessage(chatId, '✅ Channel successfully registered!');
            console.log(`Channel registered: ${msg.chat.title} (${chatId})`);
        } else {
            bot.sendMessage(chatId, '⚠️ This channel is already registered.');
        }
    } catch (e) {
        console.error('Error registering channel:', e);
        bot.sendMessage(chatId, '❌ An error occurred while trying to register the channel.');
    }
});

bot.onText(/Create New Post/, async (msg) => {
    if (msg.chat.type !== 'private') return;

    const res = await db.query('SELECT * FROM channels');
    if (res.rows.length === 0) {
        bot.sendMessage(msg.chat.id, 'You have not added this bot to any channels yet. Please add me as an admin first.');
        return;
    }

    userState[msg.chat.id] = { step: 'collecting_content', content: [] };
    bot.sendMessage(msg.chat.id, 'Please send the content you want to post (text, photos, videos, stickers, or GIFs). Type /done when finished.');
});

bot.onText(/View My Channels/, async (msg) => {
    if (msg.chat.type !== 'private') return;

    const res = await db.query('SELECT * FROM channels');
    if (res.rows.length === 0) {
        bot.sendMessage(msg.chat.id, 'No channels are registered yet.');
    } else {
        let channelList = "📋 Registered Channels:\n\n";
        res.rows.forEach(row => {
            channelList += `- ${row.title} (${row.id})\n`;
        });
        bot.sendMessage(msg.chat.id, channelList);
    }
});

bot.onText(/\/done/, async (msg) => {
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

    bot.sendMessage(chatId, '✅ Sending your post to all channels...');

    try {
        const res = await db.query('SELECT * FROM channels');
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
                console.log(`Message sent to ${row.title} (${row.id})`);
            } catch (e) {
                console.error(`Failed to send to ${row.id}: ${e.message}`);
                if (e.message.includes('chat not found')) {
                    console.log(`Removing invalid channel ${row.id} from DB.`);
                    await db.query('DELETE FROM channels WHERE id = $1', [row.id]);
                }
            }
        }
        bot.sendMessage(chatId, '🎉 Your post has been sent to all channels!');
    } catch (e) {
        console.error('Error broadcasting:', e);
        bot.sendMessage(chatId, '❌ An error occurred while sending your post.');
    }

    userState[chatId] = { step: 'menu' };
});

bot.on('message', async (msg) => {
    if (msg.chat.type !== 'private') return;

    const chatId = msg.chat.id;
    if (userState[chatId] && userState[chatId].step === 'collecting_content') {
        const { content } = userState[chatId];
        let newContent = null;

        if (msg.text && msg.text.toLowerCase() !== '/done') {
            newContent = { type: 'text', value: msg.text };
        } else if (msg.photo) {
            newContent = { type: 'photo', value: msg.photo[msg.photo.length - 1].file_id, caption: msg.caption };
        } else if (msg.video) {
            newContent = { type: 'video', value: msg.video.file_id, caption: msg.caption };
        } else if (msg.animation) {
            newContent = { type: 'animation', value: msg.animation.file_id };
        } else if (msg.sticker) {
            newContent = { type: 'sticker', value: msg.sticker.file_id };
        }

        if (newContent) {
            content.push(newContent);
            bot.sendMessage(chatId, '✅ Content added. Send more or type /done to finish.');
        }
    }
});

console.log('Bot is running...');
