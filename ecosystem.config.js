module.exports = {
  apps: [
    {
      name: "xfteam-bot",
      script: "bot.js",
      watch: true,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000
    }
  ]
};
