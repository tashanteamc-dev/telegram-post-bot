const { Telegraf, Markup } = require("telegraf");
const express = require("express");

// ==== BOT TOKEN ====
const BOT_TOKEN = process.env.BOT_TOKEN; // simpan token di secrets Replit
const bot = new Telegraf(BOT_TOKEN);

// ==== EXPRESS KEEP ALIVE ====
const app = express();
app.get("/", (req, res) => res.send("Bot is running!"));
app.listen(3000, () => console.log("Web server running on port 3000"));

// ==== STATE ====
let userChannel = {};
let postType = {};
let postContent = {};

// ==== START COMMAND ====
bot.start((ctx) => {
  ctx.reply(
    "Welcome to XFTeam Post Bot!\n\nChoose what you want to post:",
    Markup.inlineKeyboard([
      [Markup.button.callback("✍️ Post Text", "POST_TEXT")],
      [Markup.button.callback("🖼️ Post Image", "POST_IMAGE")],
      [Markup.button.callback("🌟 Post Sticker", "POST_STICKER")]
    ])
  );
});

// ==== MENU HANDLER ====
bot.action("POST_TEXT", (ctx) => {
  postType[ctx.from.id] = "text";
  ctx.reply("Please send me the text you want to post.");
});

bot.action("POST_IMAGE", (ctx) => {
  postType[ctx.from.id] = "image";
  ctx.reply("Please send me the photo you want to post.");
});

bot.action("POST_STICKER", (ctx) => {
  postType[ctx.from.id] = "sticker";
  ctx.reply("Please send me the sticker you want to post.");
});

// ==== MESSAGE HANDLER ====
bot.on("text", async (ctx) => {
  if (postType[ctx.from.id] === "text") {
    postContent[ctx.from.id] = ctx.message.text;
    await ctx.reply(
      "✅ Got your text. Send the channel username (with @) where I should post it."
    );
    postType[ctx.from.id] = "channel";
  }
});

bot.on("photo", async (ctx) => {
  if (postType[ctx.from.id] === "image") {
    const photoId = ctx.message.photo.pop().file_id;
    postContent[ctx.from.id] = photoId;
    await ctx.reply(
      "✅ Got your photo. Send the channel username (with @) where I should post it."
    );
    postType[ctx.from.id] = "channel_image";
  }
});

bot.on("sticker", async (ctx) => {
  if (postType[ctx.from.id] === "sticker") {
    postContent[ctx.from.id] = ctx.message.sticker.file_id;
    await ctx.reply(
      "✅ Got your sticker. Send the channel username (with @) where I should post it."
    );
    postType[ctx.from.id] = "channel_sticker";
  }
});

// ==== CHANNEL USERNAME ====
bot.on("text", async (ctx) => {
  const type = postType[ctx.from.id];
  if (type === "channel" || type === "channel_image" || type === "channel_sticker") {
    const channel = ctx.message.text.trim();
    userChannel[ctx.from.id] = channel;

    try {
      if (type === "channel") {
        await bot.telegram.sendMessage(channel, postContent[ctx.from.id]);
      } else if (type === "channel_image") {
        await bot.telegram.sendPhoto(channel, postContent[ctx.from.id]);
      } else if (type === "channel_sticker") {
        await bot.telegram.sendSticker(channel, postContent[ctx.from.id]);
      }

      await ctx.reply("✅ Successfully posted to " + channel);
    } catch (err) {
      console.error(err);
      await ctx.reply("❌ Failed to post. Make sure the bot is admin in the channel.");
    }

    // Reset state
    postType[ctx.from.id] = null;
    postContent[ctx.from.id] = null;
  }
});

// ==== RUN BOT ====
bot.launch();
console.log("Bot is running...");
