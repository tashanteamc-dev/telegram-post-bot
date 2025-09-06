# XFTEAM Telegram Bot

## Overview
A Node.js Telegram bot that allows users to broadcast messages, photos, videos, and other content to multiple Telegram channels simultaneously. The bot is built with Telegraf framework and uses PostgreSQL for data storage.

## Current Status
✅ **Fully operational and running**
- Server listening on port 3000
- PostgreSQL database connected
- Bot active as @xfteambot on Telegram
- All dependencies installed and up to date

## Recent Changes (September 6, 2025)
- Fixed syntax errors in bot.js (template literal escaping issues)
- Removed duplicate PORT variable declaration
- Configured workflow to run the bot automatically
- Set up environment variables (BOT_TOKEN, WEBHOOK_URL, DATABASE_URL)
- Verified database connectivity and bot functionality

## Project Architecture
```
├── bot.js          # Main bot application
├── package.json    # Node.js dependencies and scripts
├── Procfile       # Heroku deployment config
└── replit.md      # Project documentation
```

## Key Features
- Password-protected bot access (password: "xfbest")
- Auto-detection of channel additions/removals
- Support for multiple content types (text, photos, videos, animations, stickers)
- Database storage of channel configurations
- Express server for webhook handling

## Dependencies
- telegraf: ^4.16.3 (Telegram bot framework)
- express: ^4.19.2 (Web server)
- pg: ^8.12.0 (PostgreSQL client)

## Environment Variables
- BOT_TOKEN: Telegram bot token from @BotFather
- WEBHOOK_URL: Public Replit domain for webhook
- DATABASE_URL: PostgreSQL connection string (auto-configured)

## Database Schema
```sql
CREATE TABLE channels (
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  title TEXT,
  username TEXT,
  added_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, channel_id)
);
```

## Usage
1. Message @xfteambot on Telegram
2. Enter password "xfbest" when prompted
3. Add bot as administrator to your channels
4. Send content to bot - it automatically broadcasts to all connected channels

## Technical Notes
- Self-ping errors in logs are harmless (trying to reach old domain)
- Bot automatically handles channel cleanup when removed from channels
- Supports media groups and individual content items
- Uses HTML parsing for message formatting