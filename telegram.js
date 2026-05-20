const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {
  polling: false
});

async function sendTelegramMessage(message) {
  if (!process.env.TELEGRAM_CHAT_ID) {
    console.warn("Thiếu TELEGRAM_CHAT_ID trong .env");
    return;
  }
  try {
    await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, message);
    console.log("[OK] Đã gửi Telegram qua SOCKS5 proxy");
  } catch (err) {
    console.error("[Telegram ERROR]", err.message);
  }
}

module.exports = sendTelegramMessage;
