const TelegramBot = require('node-telegram-bot-api');
const { SocksProxyAgent } = require('socks-proxy-agent');
require('dotenv').config();
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Proxy SOCKS5 bạn cần dùng
const proxy = 'socks5h://198.177.252.24:4145'; // Cập nhật proxy khác nếu cần
const agent = new SocksProxyAgent(proxy);

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {
  polling: true,
  request: {
    agent
  }
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
