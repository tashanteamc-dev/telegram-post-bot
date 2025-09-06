// bot.js - XFTEAM Telegram Bot Final
const { Telegraf, Markup } = require("telegraf");
const { Client } = require("pg");
const express = require("express");
const https = require("https");

// ---------- Config ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;
const PASSWORD = "xfbest"; // Password untuk akses

// 🔹 Tentukan BASE_URL otomatis (Replit / local)
const BASE_URL =
  process.env.BASE_URL ||
  (process.env.REPL_SLUG && process.env.REPL_OWNER
    ? `https://${process.env.REPL_SLUG}.${process.env.REPL_OWNER}.repl.co`
    : `http://localhost:${PORT}`);

if (!BOT_TOKEN || !DATABASE_URL) {
  console.error("❌ BOT_TOKEN and DATABASE_URL are required!");
  process.exit(1);
}

// ---------- DB ----------
const db = new Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

db.connect()
  .then(async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS channels (
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        title TEXT,
        username TEXT,
        added_at TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (user_id, channel_id)
      );
    `);
    console.log("✅ Database connected");
  })
  .catch((err) => {
    console.error("DB error:", err.message);
    process.exit(1);
  });

// ---------- Bot ----------
const bot = new Telegraf(BOT_TOKEN);
const userState = {}; // { userId: { step, content[] } }

bot.telegram.getMe().then((me) => {
  console.log("🤖 Bot started as @" + me.username);
});

// ---------- Helpers ----------
function mainMenu() {
  return Markup.keyboard([
    ["▶️ Start"],
    ["📋 My Channels", "❌ Cancel"]
  ]).resize();
}

async function upsertChannel(userId, channelId) {
  const chat = await bot.telegram.getChat(channelId);
  const title = chat.title || channelId;
  const username = chat.username ? `@${chat.username}` : null;
  await db.query(
    `INSERT INTO channels (user_id, channel_id, title, username)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, channel_id)
     DO UPDATE SET title=EXCLUDED.title, username=EXCLUDED.username`,
    [String(userId), String(channelId), title, username]
  );
  return { channel_id: channelId, title, username };
}

async function listUserChannels(userId) {
  const res = await db.query(
    `SELECT channel_id, title, username FROM channels WHERE user_id=$1 ORDER BY title`,
    [String(userId)]
  );
  return res.rows;
}

async function broadcastContent(userId, content) {
  const channels = await listUserChannels(userId);
  if (!channels.length) return;

  for (const ch of channels) {
    try {
      for (const item of content) {
        if (item.type === "text") {
          await bot.telegram.sendMessage(ch.channel_id, item.value, { parse_mode: "HTML" });
        } else if (item.type === "photo") {
          await bot.telegram.sendPhoto(ch.channel_id, item.file_id, { caption: item.caption || "" });
        } else if (item.type === "video") {
          await bot.telegram.sendVideo(ch.channel_id, item.file_id, { caption: item.caption || "" });
        } else if (item.type === "animation") {
          await bot.telegram.sendAnimation(ch.channel_id, item.file_id);
        } else if (item.type === "sticker") {
          await bot.telegram.sendSticker(ch.channel_id, item.file_id);
        }
      }
    } catch (e) {
      console.error(`❌ Failed to send to ${ch.channel_id}:`, e.message || e);
      if (e.message && e.message.toLowerCase().includes("chat not found")) {
        await db.query(
          "DELETE FROM channels WHERE user_id=$1 AND channel_id=$2",
          [String(userId), String(ch.channel_id)]
        );
      }
    }
  }
}

// ---------- Bot Commands ----------
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  if (!userState[userId]) {
    userState[userId] = { step: "password", content: [] };
    await ctx.reply("🔑 Please enter the password to access the bot:");
  } else {
    await ctx.reply("🚀 Bot is ready!", mainMenu());
  }
});

// Password check
bot.on("text", async (ctx, next) => {
  const userId = ctx.from.id;
  const state = userState[userId];
  if (state && state.step === "password") {
    if (ctx.message.text === PASSWORD) {
      userState[userId] = { step: "menu", content: [] };
      await ctx.reply("✅ Password correct! Welcome to XFTEAM Bot.", mainMenu());
    } else {
      await ctx.reply("❌ Wrong password. Try again:");
    }
    return;
  }
  return next();
});

// Handle "Start" button
bot.hears("▶️ Start", async (ctx) => {
  userState[ctx.from.id] = { step: "menu", content: [] };
  await ctx.reply("🚀 Bot is ready! Send me text, photo, video, sticker or gif and I’ll broadcast it.", mainMenu());
});

// Handle "My Channels"
bot.hears("📋 My Channels", async (ctx) => {
  const channels = await listUserChannels(ctx.from.id);
  if (!channels.length) {
    return ctx.reply("📭 You have no channels yet.", mainMenu());
  }
  let text = "📋 Your channels:\n\n";
  channels.forEach((c, i) => {
    text += `${i + 1}. ${c.title || c.channel_id} (${c.username || "no username"})\n`;
  });
  await ctx.reply(text, mainMenu());
});

// Handle "Cancel"
bot.hears("❌ Cancel", async (ctx) => {
  userState[ctx.from.id] = { step: "menu", content: [] };
  await ctx.reply("❌ Cancelled. Back to main menu.", mainMenu());
});

// ---------- Content Capture ----------
bot.on(["text", "photo", "video", "animation", "sticker"], async (ctx) => {
  const userId = ctx.from.id;
  const state = userState[userId];
  if (!state || state.step !== "menu") return;

  let contentItem = null;
  if (ctx.message.text) {
    contentItem = { type: "text", value: ctx.message.text };
  } else if (ctx.message.photo) {
    const file = ctx.message.photo.pop();
    contentItem = { type: "photo", file_id: file.file_id, caption: ctx.message.caption };
  } else if (ctx.message.video) {
    contentItem = { type: "video", file_id: ctx.message.video.file_id, caption: ctx.message.caption };
  } else if (ctx.message.animation) {
    contentItem = { type: "animation", file_id: ctx.message.animation.file_id };
  } else if (ctx.message.sticker) {
    contentItem = { type: "sticker", file_id: ctx.message.sticker.file_id };
  }

  if (contentItem) {
    state.content.push(contentItem);
    await ctx.reply("✅ Content saved! It will be broadcast to your channels.", mainMenu());
    await broadcastContent(userId, [contentItem]);
  }
});

// ---------- Express Keep-Alive ----------
const app = express();
app.get("/", (req, res) => res.send("Bot is running ✅"));
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});

// ---------- Auto Self-Ping ----------
setInterval(() => {
  https
    .get(BASE_URL, (res) => {
      console.log("🔄 Self-ping success:", res.statusCode);
    })
    .on("error", (err) => {
      console.error("❌ Self-ping error:", err.message);
    });
}, 5 * 60 * 1000); // every 5 minutes

// ---------- Launch Bot ----------
bot.launch().then(() => console.log("🚀 Bot launched successfully"));
