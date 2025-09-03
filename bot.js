// ================== XFTEAM Multi-Channel Post Bot (per-user) ==================
// Features:
// - English-only messages
// - XFTEAM welcome link
// - Each user has their own channel list (isolated per user)
// - Add channel via 3 ways:
//     1) Auto-detect when bot is added as admin (my_chat_member)
//     2) /addchannel @username or numeric ID (-100...)
//     3) Button "➕ Add Channel" using chat selection (if client supports RequestChat)
// - Create New Post: text, photo, video, GIF/animation, and stickers
// - /done to broadcast to that user's channels only
// - 24/7 keep-alive via Express + UptimeRobot pings
// =============================================================================

const { Telegraf, Markup } = require("telegraf");
const { Client } = require("pg");
const express = require("express");

// ---------- Environment ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing");
if (!DATABASE_URL) throw new Error("DATABASE_URL is missing");

// ---------- Telegraf ----------
const bot = new Telegraf(BOT_TOKEN);
let BOT_ID = null;
bot.telegram.getMe().then((me) => {
  BOT_ID = me.id;
  console.log(`Logged in as @${me.username} (id=${BOT_ID})`);
});

// ---------- PostgreSQL ----------
const db = new Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

db.connect()
  .then(async () => {
    console.log("Connected to PostgreSQL");
    await db.query(`
      CREATE TABLE IF NOT EXISTS channels (
        user_id   TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        title     TEXT,
        username  TEXT,
        added_at  TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (user_id, channel_id)
      );
    `);
  })
  .catch((err) => console.error("DB connection error:", err));

// ---------- In-memory user state ----------
const userState = {}; // { [userId]: { step: 'menu'|'collect', content: Array } }

// ---------- Helpers ----------
function mainMenu() {
  // Reply keyboard (persistent)
  // Also include a RequestChat button (works on supported Telegram clients)
  // If not supported, users can still use /addchannel @username
  const requestChatBtn = Markup.button.requestChat("➕ Add Channel", {
    request_id: 1,
    chat_is_channel: true, // ensure channel selection
    // client may ignore rights constraints; we still verify later on server
  });

  return Markup.keyboard([
    ["📝 Create New Post"],
    ["📋 View My Channels"],
    [requestChatBtn],
    ["❌ Cancel"],
  ])
    .resize()
    .persistent();
}

async function isBotAdmin(channelId) {
  try {
    const m = await bot.telegram.getChatMember(channelId, BOT_ID);
    return m && (m.status === "administrator" || m.status === "creator");
  } catch (e) {
    return false;
  }
}

async function upsertChannelForUser(userId, channelId) {
  // Fetch chat info to get title/username
  const chat = await bot.telegram.getChat(channelId);
  if (!chat || chat.type !== "channel") {
    throw new Error("Target is not a channel.");
  }
  const title = chat.title || String(chat.id);
  const username = chat.username ? `@${chat.username}` : null;

  await db.query(
    `
      INSERT INTO channels (user_id, channel_id, title, username)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, channel_id)
      DO UPDATE SET title = EXCLUDED.title, username = EXCLUDED.username
    `,
    [String(userId), String(chat.id), title, username]
  );

  return { title, username, id: String(chat.id) };
}

async function listUserChannels(userId) {
  const res = await db.query(
    "SELECT channel_id, title, username FROM channels WHERE user_id = $1 ORDER BY title",
    [String(userId)]
  );
  return res.rows;
}

// ---------- Keep-Alive Web Server (UptimeRobot) ----------
const app = express();
app.get("/", (_, res) => res.send("Bot is running! ✅"));
app.get("/health", (_, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.listen(3000, () => console.log("Keep-alive webserver on :3000"));

// ---------- /start ----------
bot.start(async (ctx) => {
  if (ctx.chat.type !== "private") return;

  userState[ctx.from.id] = { step: "menu", content: [] };

  await ctx.reply(
    "Welcome TashanWIN\nXFTEAM\nhttps://t.me/TASHANWINXFTEAM",
    mainMenu()
  );

  await ctx.reply(
    "Use the menu below. To add a channel:\n" +
      "• Tap ➕ Add Channel (recommended), or\n" +
      "• Run /addchannel @yourchannel (I must be admin there)."
  );
});

// ---------- Auto-detect when bot is added/removed as admin ----------
bot.on("my_chat_member", async (ctx) => {
  try {
    const upd = ctx.update.my_chat_member;
    const chat = upd.chat; // channel
    const newStatus = upd.new_chat_member.status;
    const actor = upd.from; // admin who changed bot's status

    if (chat.type !== "channel") return;

    if (newStatus === "administrator") {
      // Tie channel to the admin (actor) who added the bot
      try {
        const saved = await upsertChannelForUser(actor.id, chat.id);
        console.log(`Auto-registered channel ${saved.title} (${saved.id}) for user ${actor.id}`);

        // Try to notify the actor privately (if they've started the bot before)
        try {
          await bot.telegram.sendMessage(
            actor.id,
            `✅ Channel linked: ${saved.title} ${saved.username ? saved.username : `(${saved.id})`}`
          );
        } catch (_) {
          // ignore if cannot DM user
        }
      } catch (e) {
        console.error("Auto-register error:", e.message);
      }
    } else if (newStatus === "left" || newStatus === "kicked") {
      // Bot removed → delete all user bindings to that channel
      await db.query("DELETE FROM channels WHERE channel_id = $1", [String(chat.id)]);
      console.log(`Bot removed from ${chat.title} (${chat.id}). All bindings deleted.`);
    }
  } catch (e) {
    console.error("my_chat_member handler error:", e);
  }
});

// ---------- Add Channel via /addchannel ----------
bot.command("addchannel", async (ctx) => {
  if (ctx.chat.type !== "private") return;

  const arg = ctx.message.text.split(" ").slice(1).join(" ").trim();
  if (!arg) {
    return ctx.reply(
      "Usage:\n/addchannel @yourchannel\n\n" +
        "Or tap ➕ Add Channel and pick a channel where you are an admin."
    );
  }

  let identifier = arg;
  if (!identifier.startsWith("@") && !identifier.startsWith("-100")) {
    // allow plain username without @
    identifier = `@${identifier}`;
  }

  try {
    const chat = await bot.telegram.getChat(identifier);
    if (!chat || chat.type !== "channel") {
      return ctx.reply("That target is not a channel.");
    }

    const admin = await isBotAdmin(chat.id);
    if (!admin) {
      return ctx.reply("I must be an admin in that channel. Add me as admin, then try again.");
    }

    const saved = await upsertChannelForUser(ctx.from.id, chat.id);
    return ctx.reply(
      `✅ Channel linked: ${saved.title} ${saved.username ? saved.username : `(${saved.id})`}`
    );
  } catch (e) {
    console.error("/addchannel error:", e.message);
    return ctx.reply(
      "Failed to link the channel. Make sure the username/ID is correct and the bot is admin."
    );
  }
});

// ---------- Add Channel via RequestChat (button → chat_shared) ----------
bot.on("message", async (ctx, next) => {
  try {
    const share = ctx.message && ctx.message.chat_shared;
    if (ctx.chat.type === "private" && share && share.chat_id) {
      const channelId = share.chat_id;
      const admin = await isBotAdmin(channelId);
      if (!admin) {
        await ctx.reply("I must be an admin in that channel. Add me as admin, then try again.");
        return;
      }
      const saved = await upsertChannelForUser(ctx.from.id, channelId);
      await ctx.reply(
        `✅ Channel linked: ${saved.title} ${saved.username ? saved.username : `(${saved.id})`}`
      );
      return; // handled
    }
  } catch (e) {
    console.error("chat_shared error:", e.message);
    await ctx.reply("Failed to link the channel from selection. Please try /addchannel instead.");
  }

  return next();
});

// ---------- View My Channels ----------
bot.hears("📋 View My Channels", async (ctx) => {
  if (ctx.chat.type !== "private") return;

  const rows = await listUserChannels(ctx.from.id);
  if (!rows.length) {
    return ctx.reply("You have not linked any channels yet.");
  }

  let text = "📌 Your Channels:\n\n";
  for (const r of rows) {
    text += `• ${r.title} ${r.username ? r.username : `(${r.channel_id})`}\n`;
  }
  return ctx.reply(text);
});

// ---------- Create New Post ----------
bot.hears("📝 Create New Post", async (ctx) => {
  if (ctx.chat.type !== "private") return;

  const rows = await listUserChannels(ctx.from.id);
  if (!rows.length) {
    return ctx.reply(
      "You don't have any channels yet.\n" +
        "Add me as admin in your channel, then use ➕ Add Channel or /addchannel."
    );
  }

  userState[ctx.from.id] = { step: "collect", content: [] };
  await ctx.reply(
    "Send the content you want to post (text, photo, video, GIF/animation, or sticker).\n" +
      "Type /done when finished, or /cancel to abort."
  );
});

// ---------- Finish Posting ----------
bot.command("done", async (ctx) => {
  if (ctx.chat.type !== "private") return;

  const state = userState[ctx.from.id];
  if (!state || state.step !== "collect") {
    return ctx.reply("Nothing to post. Choose 📝 Create New Post first.");
  }

  const content = state.content;
  if (!content.length) {
    userState[ctx.from.id] = { step: "menu", content: [] };
    return ctx.reply("No content received. Posting canceled.");
  }

  const rows = await listUserChannels(ctx.from.id);
  if (!rows.length) {
    userState[ctx.from.id] = { step: "menu", content: [] };
    return ctx.reply("You have no linked channels. Posting canceled.");
  }

  await ctx.reply("🚀 Sending your post to your channels...");

  for (const row of rows) {
    try {
      for (const item of content) {
        if (item.type === "text") {
          await bot.telegram.sendMessage(row.channel_id, item.value);
        } else if (item.type === "photo") {
          await bot.telegram.sendPhoto(row.channel_id, item.file_id, { caption: item.caption });
        } else if (item.type === "video") {
          await bot.telegram.sendVideo(row.channel_id, item.file_id, { caption: item.caption });
        } else if (item.type === "animation") {
          await bot.telegram.sendAnimation(row.channel_id, item.file_id);
        } else if (item.type === "sticker") {
          await bot.telegram.sendSticker(row.channel_id, item.file_id);
        }
      }
      console.log(`Sent to ${row.channel_id}`);
    } catch (e) {
      console.error(`Send failed for ${row.channel_id}: ${e.message}`);
      if (e.message && e.message.toLowerCase().includes("chat not found")) {
        // remove dead binding
        await db.query(
          "DELETE FROM channels WHERE user_id = $1 AND channel_id = $2",
          [String(ctx.from.id), String(row.channel_id)]
        );
      }
    }
  }

  await ctx.reply("✅ Done! Your post has been sent to your channels.");
  userState[ctx.from.id] = { step: "menu", content: [] };
});

// ---------- Cancel ----------
bot.command("cancel", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  userState[ctx.from.id] = { step: "menu", content: [] };
  await ctx.reply("Canceled. Back to menu.", mainMenu());
});
bot.hears("❌ Cancel", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  userState[ctx.from.id] = { step: "menu", content: [] };
  await ctx.reply("Canceled. Back to menu.", mainMenu());
});

// ---------- Collector: accept text/photo/video/animation/sticker ----------
bot.on("message", async (ctx) => {
  if (ctx.chat.type !== "private") return;

  const state = userState[ctx.from.id];
  if (!state || state.step !== "collect") return; // only collect in posting mode

  const msg = ctx.message;
  let item = null;

  if (msg.text && !msg.sticker && !msg.chat_shared) {
    // ignore /done here; /done is handled by command above
    if (msg.text.trim().toLowerCase() === "/done") return;
    if (msg.text.trim().toLowerCase() === "/cancel") return;
    item = { type: "text", value: msg.text };
  } else if (msg.photo) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    item = { type: "photo", file_id: fileId, caption: msg.caption || undefined };
  } else if (msg.video) {
    item = { type: "video", file_id: msg.video.file_id, caption: msg.caption || undefined };
  } else if (msg.animation) {
    item = { type: "animation", file_id: msg.animation.file_id };
  } else if (msg.sticker) {
    item = { type: "sticker", file_id: msg.sticker.file_id };
  }

  if (item) {
    state.content.push(item);
    await ctx.reply("✅ Content saved. Send more, or type /done when finished.");
  }
});

// ---------- Start bot ----------
bot.launch();
console.log("Bot is running...");
