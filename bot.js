// bot.js - XFTEAM per-user multi-channel broadcaster (sticker fixed, FULL)
// Requirements: node, npm; env vars: BOT_TOKEN, DATABASE_URL
// Usage: node bot.js

const { Telegraf, Markup } = require("telegraf");
const { Client } = require("pg");
const express = require("express");

// ---------- Config / env ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error("ERROR: BOT_TOKEN is required in environment");
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is required in environment");
  process.exit(1);
}

// ---------- Initialize bot & DB ----------
const bot = new Telegraf(BOT_TOKEN);

const db = new Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

db.connect()
  .then(async () => {
    console.log("Connected to PostgreSQL");
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
    console.log("Ensured channels table exists");
  })
  .catch((err) => {
    console.error("DB connection failed:", err);
    process.exit(1);
  });

// Keep small in-memory state for collecting posts per user
const userState = {}; // { [userId]: { step: 'menu'|'collect', content: [] } }

// ---------- Helpers ----------
async function botMe() {
  try {
    const me = await bot.telegram.getMe();
    return me;
  } catch (e) {
    console.error("getMe failed:", e.message || e);
    return null;
  }
}

let BOT_ID = null;
botMe().then((m) => {
  if (m) BOT_ID = m.id;
});

async function isBotAdmin(channelId) {
  try {
    if (!BOT_ID) await botMe();
    const member = await bot.telegram.getChatMember(channelId, BOT_ID);
    return member && (member.status === "administrator" || member.status === "creator");
  } catch (e) {
    return false;
  }
}

async function upsertChannelForUser(userId, channelId) {
  const chat = await bot.telegram.getChat(channelId);
  if (!chat || chat.type !== "channel") throw new Error("Target is not a channel");
  const title = chat.title || String(chat.id);
  const username = chat.username ? `@${chat.username}` : null;
  await db.query(
    `INSERT INTO channels (user_id, channel_id, title, username)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, channel_id)
     DO UPDATE SET title = EXCLUDED.title, username = EXCLUDED.username`,
    [String(userId), String(chat.id), title, username]
  );
  return { id: String(chat.id), title, username };
}

async function listUserChannels(userId) {
  const res = await db.query(
    `SELECT channel_id, title, username FROM channels WHERE user_id = $1 ORDER BY title`,
    [String(userId)]
  );
  return res.rows;
}

// Reply keyboard (persistent) with RequestChat button for channels
function mainMenuKeyboard() {
  const requestBtn = Markup.button.requestChat("➕ Add Channel", {
    request_id: 1,
    chat_is_channel: true,
  });
  return Markup.keyboard([
    ["📝 Create New Post"],
    ["📋 View My Channels"],
    [requestBtn],
    ["❌ Cancel"],
  ])
    .resize()
    .persistent();
}

// ---------- Express keep-alive ----------
const app = express();
app.get("/", (_, res) => res.send("Bot is running"));
app.get("/health", (_, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`Keep-alive webserver listening on ${PORT}`));

// ---------- Start handler ----------
bot.start(async (ctx) => {
  if (ctx.chat.type !== "private") return;
  userState[ctx.from.id] = { step: "menu", content: [] };
  try {
    await ctx.reply(
      "Welcome TashanWIN\nXFTEAM\nhttps://t.me/TASHANWINXFTEAM",
      mainMenuKeyboard()
    );
    await ctx.reply(
      "To add a channel: tap ➕ Add Channel (recommended) or use /addchannel @yourchannel\n" +
        "After adding, go to 'Create New Post' to collect post content, then type /done to broadcast.\n\n" +
        "How to include a sticker: when in Create New Post mode, just send a sticker and it will be collected."
    );
  } catch (e) {
    console.error("start reply error:", e.message || e);
  }
});

// ---------- Auto-detect: when bot added/removed to/from channel ----------
bot.on("my_chat_member", async (ctx) => {
  try {
    const upd = ctx.update.my_chat_member;
    const chat = upd.chat;
    const newStatus = upd.new_chat_member.status;
    const actor = upd.from;
    if (chat.type !== "channel") return;

    if (newStatus === "administrator") {
      try {
        const saved = await upsertChannelForUser(actor.id, chat.id);
        console.log(`Auto-registered ${saved.title} (${saved.id}) for user ${actor.id}`);
        try {
          await bot.telegram.sendMessage(
            actor.id,
            `✅ Channel linked: ${saved.title} ${saved.username ? saved.username : `(${saved.id})`}`
          );
        } catch (_) {}
      } catch (err) {
        console.error("Auto-register failed:", err.message || err);
      }
    } else if (newStatus === "left" || newStatus === "kicked") {
      await db.query("DELETE FROM channels WHERE channel_id = $1", [String(chat.id)]);
      console.log(`Bot removed from ${chat.title} (${chat.id}) — bindings removed`);
    }
  } catch (e) {
    console.error("my_chat_member handler error:", e.message || e);
  }
});

// ---------- /addchannel command ----------
bot.command("addchannel", async (ctx) => {
  if (ctx.chat.type !== "private") {
    return ctx.reply("Use this command in private chat with the bot.");
  }

  const arg = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!arg) {
    return ctx.reply(
      "Usage: /addchannel @yourchannel\nOr press ➕ Add Channel and select a channel (if your client supports it)."
    );
  }

  let target = arg;
  if (!target.startsWith("@") && !target.startsWith("-100")) {
    target = `@${target}`;
  }

  try {
    const chat = await bot.telegram.getChat(target);
    if (!chat || chat.type !== "channel") {
      return ctx.reply("That target is not a channel.");
    }

    const admin = await isBotAdmin(chat.id);
    if (!admin) {
      return ctx.reply("I must be an admin in that channel. Add me as admin, then try /addchannel again.");
    }

    const saved = await upsertChannelForUser(ctx.from.id, chat.id);
    return ctx.reply(`✅ Channel linked: ${saved.title} ${saved.username ? saved.username : `(${saved.id})`}`);
  } catch (e) {
    console.error("/addchannel error:", e.message || e);
    return ctx.reply("Failed to link the channel. Make sure the bot is admin and the username/ID is correct.");
  }
});

// ---------- Handle chat_shared from RequestChat button ----------
bot.on("message", async (ctx, next) => {
  try {
    const msg = ctx.message;
    if (ctx.chat.type === "private" && msg.chat_shared && msg.chat_shared.chat_id) {
      const channelId = msg.chat_shared.chat_id;
      const admin = await isBotAdmin(channelId);
      if (!admin) {
        await ctx.reply("I must be an admin in that channel. Add me as admin, then try again.");
        return;
      }
      const saved = await upsertChannelForUser(ctx.from.id, channelId);
      await ctx.reply(`✅ Channel linked: ${saved.title} ${saved.username ? saved.username : `(${saved.id})`}`);
      return;
    }
  } catch (e) {
    console.error("chat_shared handling error:", e.message || e);
    await ctx.reply("Failed to link from selection. Try using /addchannel @yourchannel.");
  }
  return next();
});

// ---------- View My Channels ----------
bot.hears("📋 View My Channels", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  try {
    const rows = await listUserChannels(ctx.from.id);
    if (!rows.length) return ctx.reply("You have not linked any channels yet.");
    let text = "📌 Your Channels:\n\n";
    for (const r of rows) {
      text += `• ${r.title} ${r.username ? r.username : `(${r.channel_id})`}\n`;
    }
    return ctx.reply(text);
  } catch (e) {
    console.error("view channels error:", e.message || e);
    return ctx.reply("Failed to retrieve channels.");
  }
});

// ---------- Create New Post ----------
bot.hears("📝 Create New Post", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  const rows = await listUserChannels(ctx.from.id);
  if (!rows.length) {
    return ctx.reply(
      "You don't have any channels linked. Add me as admin in your channel, then use ➕ Add Channel or /addchannel."
    );
  }
  userState[ctx.from.id] = { step: "collect", content: [] };
  await ctx.reply(
    "Send the content you want to post (text, photo, video, GIF/animation, or sticker).\n" +
      "Type /done when finished or /cancel to abort.\n\n" +
      "To add a sticker: send a sticker message while in this mode."
  );
});

// ---------- Done (broadcast) ----------
bot.command("done", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  const state = userState[ctx.from.id];
  if (!state || state.step !== "collect") return ctx.reply("Nothing to post. Use 'Create New Post' first.");
  const content = state.content || [];
  if (!content.length) {
    userState[ctx.from.id] = { step: "menu", content: [] };
    return ctx.reply("No content collected. Posting canceled.");
  }

  const channels = await listUserChannels(ctx.from.id);
  if (!channels.length) {
    userState[ctx.from.id] = { step: "menu", content: [] };
    return ctx.reply("You have no linked channels. Posting canceled.");
  }

  await ctx.reply("🚀 Sending your post to your channels...");
  for (const ch of channels) {
    try {
      for (const item of content) {
        if (item.type === "text") {
          await bot.telegram.sendMessage(ch.channel_id, item.value);
        } else if (item.type === "photo") {
          await bot.telegram.sendPhoto(ch.channel_id, item.file_id, { caption: item.caption });
        } else if (item.type === "video") {
          await bot.telegram.sendVideo(ch.channel_id, item.file_id, { caption: item.caption });
        } else if (item.type === "animation") {
          await bot.telegram.sendAnimation(ch.channel_id, item.file_id);
        } else if (item.type === "sticker") {
          // send as sticker
          await bot.telegram.sendSticker(ch.channel_id, item.file_id);
        }
      }
      console.log(`Sent to ${ch.channel_id}`);
    } catch (e) {
      console.error(`Failed to send to ${ch.channel_id}:`, e.message || e);
      if (e.message && e.message.toLowerCase().includes("chat not found")) {
        await db.query("DELETE FROM channels WHERE user_id = $1 AND channel_id = $2", [
          String(ctx.from.id),
          String(ch.channel_id),
        ]);
      }
    }
  }

  userState[ctx.from.id] = { step: "menu", content: [] };
  return ctx.reply("✅ Done! Your post has been sent to your channels.");
});

// ---------- Cancel ----------
bot.command("cancel", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  userState[ctx.from.id] = { step: "menu", content: [] };
  return ctx.reply("Canceled. Back to menu.", mainMenuKeyboard());
});
bot.hears("❌ Cancel", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  userState[ctx.from.id] = { step: "menu", content: [] };
  return ctx.reply("Canceled. Back to menu.", mainMenuKeyboard());
});

// ---------- Collector: accept text/photo/video/animation/sticker ----------
bot.on("message", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  const state = userState[ctx.from.id];
  if (!state || state.step !== "collect") return;

  const msg = ctx.message;
  if (!msg) return;

  // ignore chat_shared (handled earlier)
  if (msg.chat_shared) return;

  // If user sends the channel username/ID while still in collect mode, we treat it as text content,
  // but normally users should type /done to broadcast. So we keep collector behavior simple.
  try {
    let item = null;
    if (msg.text && !msg.sticker) {
      const txt = msg.text.trim();
      if (txt.toLowerCase() === "/done" || txt.toLowerCase() === "/cancel") return;
      item = { type: "text", value: txt };
    } else if (msg.photo) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      item = { type: "photo", file_id: fileId, caption: msg.caption || undefined };
    } else if (msg.video) {
      item = { type: "video", file_id: msg.video.file_id, caption: msg.caption || undefined };
    } else if (msg.animation) {
      item = { type: "animation", file_id: msg.animation.file_id };
    } else if (msg.sticker) {
      // <- **explicit sticker collector**
      item = { type: "sticker", file_id: msg.sticker.file_id };
    }

    if (item) {
      state.content.push(item);
      await ctx.reply("✅ Content saved. Send more, or type /done when finished.");
    }
  } catch (e) {
    console.error("collector error:", e.message || e);
    await ctx.reply("Failed to read the message. Try sending again.");
  }
});

// ---------- Launch ----------
bot.launch({ polling: true }).then(() => {
  console.log("Bot launched with polling");
});

// graceful stop
process.once("SIGINT", () => {
  bot.stop("SIGINT");
  process.exit(0);
});
process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
  process.exit(0);
});
