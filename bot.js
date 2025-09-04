// bot.js - XFTEAM Telegram Bot Full Version
const { Telegraf, Markup } = require("telegraf");
const { Client } = require("pg");
const express = require("express");

// ---------- Config ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;
const PASSWORD = "xfbest"; // <-- Password for access

if (!BOT_TOKEN || !DATABASE_URL) {
  console.error("BOT_TOKEN and DATABASE_URL are required!");
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
    console.log("Database ready");
  })
  .catch((err) => {
    console.error("DB connection error:", err);
    process.exit(1);
  });

// ---------- Bot ----------
const bot = new Telegraf(BOT_TOKEN);
const userState = {}; // { userId: { step, content[] } }

let BOT_ID = null;
bot.telegram.getMe().then((me) => (BOT_ID = me.id));

// ---------- Helpers ----------
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
      console.error(`Failed to send to ${ch.channel_id}:`, e.message || e);
      if (e.message && e.message.toLowerCase().includes("chat not found")) {
        await db.query("DELETE FROM channels WHERE user_id=$1 AND channel_id=$2", [userId, ch.channel_id]);
      }
    }
  }
}

// ---------- Express keep-alive & Webhook Setup ----------
const app = express();
app.get("/", (_, res) => res.send("Bot is running"));
app.use(bot.webhookCallback("/"));

// ---------- Start ----------
bot.start(async (ctx) => {
  if (ctx.chat.type !== "private") return;

  // Set state for password check
  userState[ctx.from.id] = { step: "awaiting_password", content: [] };

  await ctx.reply(
    "Welcome TashanWIN\nXFTEAM\nhttps://t.me/TASHANWINXFTEAM\n\nPlease enter the password to use this bot:"
  );
});

// ---------- Auto-detect channel ----------
bot.on("my_chat_member", async (ctx) => {
  try {
    const { chat, from, new_chat_member } = ctx.update.my_chat_member;
    if (chat.type !== "channel") return;

    if (new_chat_member.status === "administrator") {
      const saved = await upsertChannel(from.id, chat.id);
      console.log(`Auto-registered channel ${saved.title} for user ${from.id}`);
      try {
        await bot.telegram.sendMessage(
          from.id,
          `✅ Channel linked: ${saved.title} ${saved.username || `(${saved.channel_id})`}`
        );
      } catch {}
    } else if (new_chat_member.status === "left" || new_chat_member.status === "kicked") {
      await db.query("DELETE FROM channels WHERE channel_id=$1", [chat.id]);
      console.log(`Removed channel ${chat.title} from DB`);
    }
  } catch (e) {
    console.error("my_chat_member error:", e.message || e);
  }
});

// ---------- View Channels ----------
bot.hears("📋 View My Channels", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  const channels = await listUserChannels(ctx.from.id);
  if (!channels.length) return ctx.reply("You have not linked any channels yet.");
  let text = "📌 Your Channels:\n";
  for (const ch of channels) text += `• ${ch.title} ${ch.username || `(${ch.channel_id})`}\n`;
  return ctx.reply(text);
});

// ---------- Cancel ----------
bot.command("cancel", async (ctx) => {
  userState[ctx.from.id] = { step: "menu", content: [] };
  return ctx.reply("Canceled. Back to menu.", Markup.keyboard([["📋 View My Channels"], ["❌ Cancel"]]).resize());
});
bot.hears("❌ Cancel", async (ctx) => {
  userState[ctx.from.id] = { step: "menu", content: [] };
  return ctx.reply("Canceled. Back to menu.", Markup.keyboard([["📋 View My Channels"], ["❌ Cancel"]]).resize());
});

// ---------- Collect & Auto Broadcast ----------
bot.on("message", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  const msg = ctx.message;
  if (!msg || !msg.text && !msg.photo && !msg.video && !msg.animation && !msg.sticker) return;

  const state = userState[ctx.from.id];
  if (!state) return;

  // Password check first
  if (state.step === "awaiting_password") {
    if (msg.text === PASSWORD) {
      state.step = "menu";
      await ctx.reply(
        "✅ Password correct! You can now use the bot.",
        Markup.keyboard([["📋 View My Channels"], ["❌ Cancel"]]).resize()
      );
    } else {
      await ctx.reply("❌ Wrong password! Please contact @kasiatashan");
    }
    return;
  }

  // Only collect content if user passed password
  if (state.step === "menu") {
    let item = null;
    if (msg.text) {
      item = { type: "text", value: msg.text };
    } else if (msg.photo) {
      item = { type: "photo", file_id: msg.photo[msg.photo.length - 1].file_id, caption: msg.caption || "" };
    } else if (msg.video) {
      item = { type: "video", file_id: msg.video.file_id, caption: msg.caption || "" };
    } else if (msg.animation) {
      item = { type: "animation", file_id: msg.animation.file_id };
    } else if (msg.sticker) {
      item = { type: "sticker", file_id: msg.sticker.file_id };
    }

    if (item) {
      state.content.push(item);
      await ctx.reply("✅ Content received. Sending to all your channels...");
      await broadcastContent(ctx.from.id, state.content);
      state.content = [];
      await ctx.reply("✅ Done! Post sent to all your channels.");
    }
  }
});

// ---------- Launch ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server listening on port ${PORT}`);
  // Set the webhook for the Telegram Bot
  const WEBHOOK_URL = process.env.WEBHOOK_URL;
  if (WEBHOOK_URL) {
    await bot.telegram.setWebhook(WEBHOOK_URL);
    console.log("Webhook has been set successfully.");
  } else {
    console.error("WEBHOOK_URL is not set!");
  }
});