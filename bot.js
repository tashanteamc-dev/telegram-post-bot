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
    console.log('Connected to PostgreSQL database');
    return db.query(`
        CREATE TABLE IF NOT EXISTS channels (
            id TEXT PRIMARY KEY,
            title TEXT
        );
    `);
}).catch(err => console.error('Database connection error', err));

const userState = {};

async function isBotAdmin(channelId) {
    try {
        const chatMember = await bot.getChatMember(channelId, bot.options.token.split(':')[0]);
        return chatMember.status === 'administrator';
    } catch (e) {
        return false;
    }
}

// Handler for the /start command
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

bot.onText(/\/register|\/addchannel/, async (msg) => {
    const chatId = msg.chat.id;
    if (msg.chat.type === 'private') {
        bot.sendMessage(chatId, 'This command must be used inside a channel where I am an admin.');
        return;
    }

    const botIsAdmin = await isBotAdmin(chatId);
    if (botIsAdmin) {
        try {
            const res = await db.query('SELECT * FROM channels WHERE id = $1', [chatId]);
            if (res.rows.length === 0) {
                await db.query('INSERT INTO channels (id, title) VALUES ($1, $2)', [chatId, msg.chat.title]);
                bot.sendMessage(chatId, 'Channel successfully registered! You can now use "View My Channels" in our private chat.');
                console.log(`Channel registered via /addchannel: ${msg.chat.title} (${chatId})`);
            } else {
                bot.sendMessage(chatId, 'This channel is already registered.');
            }
        } catch (e) {
            console.error('Error registering channel:', e);
            bot.sendMessage(chatId, 'An error occurred while trying to register the channel.');
        }
    } else {
        bot.sendMessage(chatId, 'I must be an administrator in this channel to register it.');
    }
});

bot.onText(/Create New Post/, async (msg) => {
    const chatId = msg.chat.id;
    if (msg.chat.type !== 'private') return;

    const res = await db.query('SELECT * FROM channels');
    if (res.rows.length === 0) {
        bot.sendMessage(chatId, 'You have not added this bot to any channels yet. Please add this bot as an admin to your channels first.');
    } else {
        userState[chatId] = { step: 'collecting_content', content: [] };
        bot.sendMessage(chatId, 'Please send the content you want to post (text, photos, videos, stickers, or GIFs). Type /done when you are finished.');
    }
});

bot.onText(/View My Channels/, async (msg) => {
    const chatId = msg.chat.id;
    if (msg.chat.type !== 'private') return;

    const res = await db.query('SELECT * FROM channels');
    if (res.rows.length === 0) {
        bot.sendMessage(chatId, 'You have not added this bot to any channels yet.');
    } else {
        let channelList = "Here are the IDs of the registered channels:\n\n";
        res.rows.forEach(row => {
            channelList += `${row.title} (${row.id})\n`;
        });
        bot.sendMessage(chatId, channelList);
    }
});

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

    bot.sendMessage(chatId, 'Okay, I will start sending your post to all channels.');

    db.query('SELECT * FROM channels', async (err, res) => {
        if (err) {
            console.error(err);
            bot.sendMessage(chatId, 'An error occurred while retrieving the channel list.');
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
                console.log(`Message successfully sent to channel ${row.id}`);
            } catch (e) {
                console.error(`Failed to send to channel ${row.id}: ${e.message}`);
                if (e.message.includes('chat not found')) {
                    console.log(`Removing channel ${row.id} from the database.`);
                    await db.query('DELETE FROM channels WHERE id = $1', [row.id]);
                }
            }
        }
        
        bot.sendMessage(chatId, 'Your post has been successfully sent to all channels!');
        userState[chatId] = { step: 'menu' };
    });
});

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
    } else {
        const text = msg.text ? msg.text.toLowerCase() : '';
        if (text && !text.startsWith('/')) {
            bot.sendMessage(chatId, 'Silakan pilih dari menu atau gunakan perintah /start untuk menampilkan menu.');
        }
    }
});

console.log('Bot is running...');
