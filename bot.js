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

// Automatically detect if bot is added/removed from a channel
bot.on('my_chat_member', async (msg) => {
    const chat = msg.chat;
    const newStatus = msg.new_chat_member.status;

    if (chat.type === 'channel') {
        if (newStatus === 'administrator') {
            try {
                await db.query(
                    'INSERT INTO channels (id, title) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET title = $2',
                    [chat.id, chat.title]
                );
                console.log(`Bot added as admin in channel: ${chat.title} (${chat.id})`);
            } catch (e) {
                console.error('Error saving channel:', e);
            }
        } else if (newStatus === 'left' || newStatus === 'kicked') {
            try {
                await db.query('DELETE FROM channels WHERE id = $1', [chat.id]);
                console.log(`Bot removed from channel: ${chat.title} (${chat.id})`);
            } catch (e) {
                console.error('Error removing channel:', e);
            }
        }
    }
});

// Show main menu
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (msg.chat.type !== 'private') return;

    userState[chatId] = { step: 'menu' };
    const welcomeMessage = "Welcome!\n\nUse the buttons below to manage posts and channels.";

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
        bot.sendMessage(chatId, 'No channels found. Please add this bot as an admin to your channels first.');
    } else {
        userState[chatId] = { step: 'collecting_content', content: [] };
        bot.sendMessage(chatId, 'Send the content you want to post (text, photo, video, sticker, or GIF). Type /done when finished.');
    }
});

// View channels
bot.onText(/View My Channels/, async (msg) => {
    const chatId = msg.chat.id;
    if (msg.chat.type !== 'private') return;

    const res = await db.query('SELECT * FROM channels');
    if (res.rows.length === 0) {
        bot.sendMessage(chatId, 'No channels are registered yet.');
    } else {
        let channelList = "Registered channels:\n\n";
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
        bot.sendMessage(chatId, 'Nothing to post. Use "Create New Post" first.');
        return;
    }

    const content = userState[chatId].content;
    if (content.length === 0) {
        bot.sendMessage(chatId, 'No conte
