const TelegramBot = require('node-telegram-bot-api');
const Datastore = require('nedb');

// Replace with your bot's API token
const token = '8326864561:AAHsOmwu0jKhKcSAdXubqTzALdOgKiBNWyo';
const bot = new TelegramBot(token, { polling: true });

// Object to store user conversation state and media
const userState = {};

// Database to store channel IDs
const db = new Datastore({ filename: 'channels.db', autoload: true });

// Function to check if the bot is an admin in a channel
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
    
    // Welcome message you requested
    const welcomeMessage = "What can this bot do\nWelcome TashanWIN\nXFTEAM\nhttps://t.me/TASHANWINXFTEAM";
    
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

// Handler for the "Create New Post" button
bot.onText(/Create New Post/, async (msg) => {
    const chatId = msg.chat.id;
    if (msg.chat.type !== 'private') return;

    db.find({}, (err, docs) => {
        if (docs.length === 0) {
            bot.sendMessage(chatId, 'You have not added this bot to any channels yet. Please add this bot as an admin to your channels first.');
        } else {
            userState[chatId] = { step: 'collecting_content', content: [] };
            bot.sendMessage(chatId, 'Please send the content you want to post (text, photos, videos, stickers, or GIFs). Type /done when you are finished.');
        }
    });
});

// Handler for the "View My Channels" button
bot.onText(/View My Channels/, (msg) => {
    const chatId = msg.chat.id;
    if (msg.chat.type !== 'private') return;

    db.find({}, (err, docs) => {
        if (docs.length === 0) {
            bot.sendMessage(chatId, 'You have not added this bot to any channels yet.');
        } else {
            let channelList = "Here are the IDs of the registered channels:\n\n";
            docs.forEach(doc => {
                channelList += `${doc.id}\n`;
            });
            bot.sendMessage(chatId, channelList);
        }
    });
});

// Handler for the /done command
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

    db.find({}, async (err, docs) => {
        if (err) {
            console.error(err);
            bot.sendMessage(chatId, 'An error occurred while retrieving the channel list.');
            return;
        }

        if (docs.length === 0) {
            bot.sendMessage(chatId, 'No channels are registered. Post canceled.');
            userState[chatId] = { step: 'menu' };
            return;
        }

        for (const doc of docs) {
            try {
                for (const item of content) {
                    if (item.type === 'text') {
                        await bot.sendMessage(doc.id, item.value);
                    } else if (item.type === 'photo') {
                        await bot.sendPhoto(doc.id, item.value, { caption: item.caption });
                    } else if (item.type === 'video') {
                        await bot.sendVideo(doc.id, item.value, { caption: item.caption });
                    } else if (item.type === 'animation') {
                        await bot.sendAnimation(doc.id, item.value);
                    } else if (item.type === 'sticker') {
                        await bot.sendSticker(doc.id, item.value);
                    }
                }
                console.log(`Message successfully sent to channel ${doc.id}`);
            } catch (e) {
                console.error(`Failed to send to channel ${doc.id}: ${e.message}`);
                if (e.message.includes('chat not found')) {
                    console.log(`Removing channel ${doc.id} from the database.`);
                    db.remove({ id: doc.id }, {}, (err, numRemoved) => {});
                }
            }
        }
        
        bot.sendMessage(chatId, 'Your post has been successfully sent to all channels!');
        userState[chatId] = { step: 'menu' };
    });
});


// New handler to automatically detect and add channels
bot.on('channel_post', async (msg) => {
    const chatId = msg.chat.id;
    const botIsAdmin = await isBotAdmin(chatId);

    if (botIsAdmin) {
        db.update({ id: chatId }, { id: chatId, title: msg.chat.title }, { upsert: true }, (err, numReplaced, upsert) => {
            if (err) console.error(err);
            else if (upsert) {
                console.log(`New channel automatically added: ${msg.chat.title} (${chatId})`);
            }
        });
    }
});


// Handler for all messages
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (msg.chat.type !== 'private' || !userState[chatId] || userState[chatId].step !== 'collecting_content') {
        return;
    }

    const { content } = userState[chatId];
    let newContent = {};

    if (msg.text && !msg.photo && !msg.video && !msg.animation && !msg.sticker) {
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
});

console.log('Bot is running...');