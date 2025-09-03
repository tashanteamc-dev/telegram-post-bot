const { Telegraf, Markup } = require("telegraf");
const { Client } = require("pg");
const express = require("express");

// --- Bot & Database Setup ---
const bot = new Telegraf(process.env.BOT_TOKEN);

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
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        title TEXT
      );
    `);
  })
  .catch((err) => console.error("Database connection error", err));

const userState = {};

// --- Helper ---
async function registerChannel(chat) {
  try {
    const res = await db.query("SELECT * FROM channels WHERE id = $1", [chat.id]);
    if (res.rows.length === 0) {
      await db.query("INSERT INTO channels (id, title) VALUES ($1, $2)", [
        chat.id,
        chat.title || "Unnamed Channel",
      ]);
      console.log(`Channel registered: ${chat.title} (${chat.id})`);
    }
  } catch (e) {
    console.error("Error registering channel:", e);
  }
}

// --- Start Command ---
bot.start((ctx) => {
  if (ctx.chat.type !== "private") return;

  ctx.reply(
    "Welcome TashanWIN\nXFTEAM\nhttps://t.me/TASHANWINXFTEAM",
    Markup.keyboard([
      ["📝 Create New Post"],
      ["📋 View My Channels"],
    ])
      .resize()
      .persistent()
  );

  userState[ctx.chat.id] = { step: "menu" };
});

// --- Auto-detect when bot added to a channel ---
bot.on("my_chat_member", async (ctx) => {
  const status = ctx.update.my_chat_member.new_chat_member.status;
  const chat = ctx.update.my_chat_member.chat;

  if (status === "administrator") {
    await registerChannel(chat);
    try {
      await bot.telegram.sendMessage(
        chat.id,
        "✅ Bot registered successfully! Now I can post here."
      );
    } catch (e) {
      console.error("Cannot send message in channel:", e.message);
    }
  }
});

// --- View Channels ---
bot.hears("📋 View My Channels", async (ctx) => {
  if (ctx.chat.type !== "private") return;

  const res = await db.query("SELECT * FROM channels");
  if (res.rows.length === 0) {
    ctx.reply("You have not added this bot to any channels yet.");
  } else {
    let list = "📌 Registered Channels:\n\n";
    res.rows.forEach((row) => {
      list += `${row.title} (${row.id})\n`;
    });
    ctx.reply(list);
  }
});

// --- Create New Post ---
bot.hears("📝 Create New Post", async (ctx) => {
  if (ctx.chat.type !== "private") return;

  const res = await db.query("SELECT * FROM channels");
  if (res.rows.length === 0) {
    ctx.reply("You have not added this bot to any channels yet.");
  } else {
    userState[ctx.chat.id] = { step: "collecting_content", content: [] };
    ctx.reply(
      "Send me the content you want to post (text, photo, video, GIF, or sticker).\n\nType /done when finished."
    );
  }
});

// --- Done Posting ---
bot.command("done", async (ctx) => {
  const chatId = ctx.chat.id;
  if (
    ctx.chat.type !== "private" ||
    !userState[chatId] ||
    userState[chatId].step !== "collecting_content"
  ) {
    ctx.reply("There is nothing to post. Please use 'Create New Post' first.");
    return;
  }

  const content = userState[chatId].content;
  if (content.length === 0) {
    ctx.reply("No content was sent. Post canceled.");
    userState[chatId] = { step: "menu" };
    return;
  }

  ctx.reply("🚀 Sending your post to all channels...");

  const res = await db.query("SELECT * FROM channels");
  for (const row of res.rows) {
    try {
      for (const item of content) {
        if (item.type === "text") {
          await bot.telegram.sendMessage(row.id, item.value);
        } else if (item.type === "photo") {
          await bot.telegram.sendPhoto(row.id, item.value, { caption: item.caption });
        } else if (item.type === "video") {
          await bot.telegram.sendVideo(row.id, item.value, { caption: item.caption });
        } else if (item.type === "animation") {
          await bot.telegram.sendAnimation(row.id, item.value);
        } else if (item.type === "sticker") {
          await bot.telegram.sendSticker(row.id, item.value);
        }
      }
      console.log(`Message sent to channel ${row.id}`);
    } catch (e) {
      console.error(`Failed to send to channel ${row.id}: ${e.message}`);
      if (e.message.includes("chat not found")) {
        await db.query("DELETE FROM channels WHERE id = $1", [row.id]);
      }
    }
  }

  ctx.reply("✅ Post successfully sent to all channels!");
  userState[chatId] = { step: "menu" };
});

// --- Message Collector ---
bot.on("message", (ctx) => {
  const chatId = ctx.chat.id;
  if (ctx.chat.type !== "private") return;

  if (userState[chatId] && userState[chatId].step === "collecting_content") {
    const { content } = userState[chatId];
    let newContent = null;

    if (ctx.message.text && !ctx.message.sticker) {
      if (ctx.message.text.toLowerCase() === "/done") return;
      newContent = { type: "text", value: ctx.message.text };
    } else if (ctx.message.photo) {
      const fileId = ctx.message.photo.pop().file_id;
      newContent = { type: "photo", value: fileId, caption: ctx.message.caption };
    } else if (ctx.message.video) {
      newContent = { type: "video", value: ctx.message.video.file_id, caption: ctx.message.caption };
    } else if (ctx.message.animation) {
      newContent = { type: "animation", value: ctx.message.animation.file_id };
    } else if (ctx.message.sticker) {
      newContent = { type: "sticker", value: ctx.message.sticker.file_id };
    }

    if (newContent) {
      content.push(newContent);
      ctx.reply("✅ Content received. Send more or type /done to finish.");
    }
  }
});

// --- Express Keep-Alive (for UptimeRobot) ---
const app = express();
app.get("/", (req, res) => res.send("Bot is running!"));
app.listen(3000, () => console.log("Webserver running on port 3000"));

// --- Start Bot ---
bot.launch();
console.log("Bot is running...");
