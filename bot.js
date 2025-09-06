// bot.js - XFTEAM Telegram Bot Final with Start Button & Auto Keep Alive
const { Telegraf, Markup } = require("telegraf");
const { Client } = require("pg");
const express = require("express");
const https = require("https");

// ---------- Config ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;
const PASSWORD = "xfbest"; // <-- Password for access

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
        await db.query("
