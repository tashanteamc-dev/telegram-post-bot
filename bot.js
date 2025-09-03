const { Telegraf, Markup, session } = require("telegraf");
const { Client } = require("pg");
const express = require("express");

// ==== BOT TOKEN ====
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN must be provided!");
}
const bot = new Telegraf(BOT_TOKEN);

// ==== DATABASE CONNECTION ====
const db = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

db.connect()
  .then(() => {
    console.log("Connected to PostgreSQL database");
    return db.query(`
      CREATE TABLE IF NOT EXISTS user_channels (
        user_id BIGINT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_title TEXT,
        PRIMARY KEY (user_id, channel_id)
      );
    `);
  })
  .catch((err) => console.error("Database connection error", err));

// ==== EXPRESS KEEP ALIVE ====
const app = express();
app.get("/", (req, res) => res.send("Bot is running!"));
app.listen(3000, () => console.log("Web server running on port 3000"));

// ==== Session middleware ====
bot.use(session());

// ==== START COMMAND ====
bot.start((ctx) => {
  ctx.reply(
    "Welcome to XFTeam Post Bot!\n\nUse this bot to manage and send posts to your channels.",
    Markup.inlineKeyboard([
      [Markup.button.callback("Create New Post", "CREATE_POST")],
      [Markup.button.callback("View My Channels", "VIEW_CHANNELS")],
    ])
  );
});

// ==== ACTION HANDLERS ====
bot.action("CREATE_POST", (ctx) => {
  // Store user's state for the posting process
  ctx.session = { post: { step: "collecting_content" } };
  ctx.reply("Please send the content you want to post (text, photos, stickers, etc.). Type /done when finished.");
});

bot.action("VIEW_CHANNELS", async (ctx) => {
  const userId = ctx.from.id;
  try {
    const res = await db.query("SELECT * FROM user_channels WHERE user_id = $1", [userId]);
    if (res.rows.length === 0) {
      ctx.reply("You have not added any channels yet. Please use the /addchannel command inside a channel first.");
    } else {
      let channelList = "Here are your registered channels:\n\n";
      res.rows.forEach((row) => {
        channelList += `- ${row.channel_title} (${row.channel_id})\n`;
      });
      ctx.reply(channelList);
    }
  } catch (err) {
    console.error(err);
    ctx.reply("An error occurred while fetching your channels.");
  }
});

// ==== ADD CHANNEL COMMAND (to be used inside a channel) ====
bot.command("addchannel", async (ctx) => {
  const chatId = ctx.message.chat.id;
  const userId = ctx.from.id;

  if (ctx.message.chat.type === "private") {
    ctx.reply("This command must be used inside a channel where I am an admin.");
    return;
  }

  // Make sure bot is an admin in the channel
  try {
    const chatMember = await bot.telegram.getChatMember(chatId, bot.botInfo.id);
    if (chatMember.status === "administrator") {
      // Check if channel is already registered for this user
      const res = await db.query("SELECT * FROM user_channels WHERE user_id = $1 AND channel_id = $2", [userId, chatId]);
      if (res.rows.length === 0) {
        // Add channel to database
        await db.query("INSERT INTO user_channels (user_id, channel_id, channel_title) VALUES ($1, $2, $3)", [userId, chatId, ctx.message.chat.title]);
        ctx.reply(`Channel "${ctx.message.chat.title}" successfully registered for you!`);
      } else {
        ctx.reply("This channel is already registered for you.");
      }
    } else {
      ctx.reply("I must be an administrator in this channel to register it.");
    }
  } catch (err) {
    console.error(err);
    ctx.reply("An error occurred while trying to register the channel. Please ensure I have administrator privileges.");
  }
});

// ==== MESSAGE HANDLER FOR POSTING ====
bot.on("message", async (ctx) => {
  const userId = ctx.from.id;
  if (!ctx.session || !ctx.session.post || ctx.session.post.step !== "collecting_content") return;

  const content = ctx.session.post.content || [];
  let newContent;

  if (ctx.message.text === "/done") {
    if (content.length === 0) {
      ctx.reply("No content was sent. Post canceled.");
    } else {
      const res = await db.query("SELECT * FROM user_channels WHERE user_id = $1", [userId]);
      if (res.rows.length === 0) {
        ctx.reply("You have no channels to post to. Use /addchannel in a channel first.");
      } else {
        ctx.session.post.step = "select_channel";
        const channelButtons = res.rows.map((row) =>
          [Markup.button.callback(row.channel_title, `post_to_${row.channel_id}`)]
        );
        ctx.reply("Okay, now select the channel where you want to post:", Markup.inlineKeyboard(channelButtons));
      }
    }
    // Reset state after handling /done
    delete ctx.session.post;
    return;
  }

  // Handle different message types
  if (ctx.message.text) {
    newContent = { type: "text", value: ctx.message.text };
  } else if (ctx.message.photo) {
    const fileId = ctx.message.photo.pop().file_id;
    newContent = { type: "photo", value: fileId, caption: ctx.message.caption };
  } else if (ctx.message.sticker) {
    const fileId = ctx.message.sticker.file_id;
    newContent = { type: "sticker", value: fileId };
  } else if (ctx.message.animation) {
    const fileId = ctx.message.animation.file_id;
    newContent = { type: "animation", value: fileId };
  } else {
    ctx.reply("Unsupported message type.");
    return;
  }

  content.push(newContent);
  ctx.session.post.content = content;
  ctx.reply("Content received. Send more content or type /done to post.");
});

// ==== POST TO CHANNEL HANDLER ====
bot.action(/post_to_(.+)/, async (ctx) => {
  const userId = ctx.from.id;
  const channelId = ctx.match[1];
  const postContent = ctx.session.post.content;

  if (!postContent) {
    ctx.reply("Post content not found. Please start a new post.");
    return;
  }

  try {
    for (const item of postContent) {
      if (item.type === "text") {
        await bot.telegram.sendMessage(channelId, item.value);
      } else if (item.type === "photo") {
        await bot.telegram.sendPhoto(channelId, item.value, { caption: item.caption });
      } else if (item.type === "sticker") {
        await bot.telegram.sendSticker(channelId, item.value);
      } else if (item.type === "animation") {
        await bot.telegram.sendAnimation(channelId, item.value);
      }
    }
    await ctx.reply(`✅ Post successfully sent to channel ${channelId}!`);
  } catch (err) {
    console.error(err);
    await ctx.reply("❌ Failed to send post. Please make sure the bot is still an admin in the channel.");
  }
  // Clear the session state
  delete ctx.session.post;
});

// Run the bot
bot.launch();
console.log("Bot is running...");