// Zalo daily bot — nhúng vào API (index.js) hoặc chạy độc lập (`node bot.js`).
// Xem README_zalo_bot.md để biết kiến trúc và cách vận hành.
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// Cấu hình lấy từ .env (dùng chung TELEGRAM_TOKEN/CHAT_ID với phần còn lại của project)
const TARGET_ID = process.env.ZALO_TARGET_ID || "";
const MESSAGE   = process.env.ZALO_MESSAGE   || "";
const TG_TOKEN  = process.env.TELEGRAM_TOKEN || "";
const TG_CHAT   = process.env.TELEGRAM_CHAT_ID || "";
const CRON_EXPR = process.env.ZALO_CRON || "30 17 * * *"; // mặc định 17h30
const ENABLED   = process.env.ZALO_ENABLED !== "false";   // đặt ZALO_ENABLED=false để tắt

const CRED_FILE = path.join(__dirname, "cred.json");
const SENT_FILE = path.join(__dirname, "last_sent.txt");

// zca-js được nạp lười (lazy) trong startZaloBot() để việc thiếu thư viện / chưa
// cấu hình không làm sập tiến trình API khi require('./bot').
let Zalo, ThreadType;
let api = null;
let started = false;

async function tg(text) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text }),
  }).catch(() => {});
}

async function sendQR(qrPath) {
  const form = new FormData();
  form.append("chat_id", TG_CHAT);
  form.append("photo", new Blob([fs.readFileSync(qrPath)]), "qr.png");
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, { method: "POST", body: form });
}

// ---- Theo dõi đối tượng có trả lời sau khi gửi không ----
let nudgeTimers = [];
function clearNudges() {
  nudgeTimers.forEach((t) => clearTimeout(t));
  nudgeTimers = [];
}
function scheduleNudges() {
  clearNudges();
  // nhắc lúc 20', 25', 30' nếu vẫn chưa thấy trả lời; sau đó thôi
  [20, 25, 30].forEach((min) => {
    const t = setTimeout(() => {
      tg(`⏰ Đã ${min} phút kể từ khi gửi mà đối tượng chưa trả lời.`);
    }, min * 60 * 1000);
    nudgeTimers.push(t);
  });
}
function attachListener() {
  api.listener.on("message", (m) => {
    if (m.isSelf) return;
    if (m.type === ThreadType.User && m.threadId === TARGET_ID) {
      clearNudges(); // đối tượng đã trả lời → ngừng nhắc
    }
  });
}

async function loginFromFile() {
  const cred = JSON.parse(fs.readFileSync(CRED_FILE));
  const zalo = new Zalo();
  api = await zalo.login(cred);
  attachListener();
  api.listener.start();
}

async function relogin() {
  await tg("Đang tạo QR mới…");
  try { api?.listener.stop(); } catch {}
  const zalo = new Zalo();
  api = await zalo.loginQR({}, (qrPath) => sendQR(qrPath));
  const c = api.getContext();
  fs.writeFileSync(CRED_FILE, JSON.stringify({ cookie: c.cookie, imei: c.imei, userAgent: c.userAgent }));
  attachListener();
  api.listener.start();
  await tg("✅ Đăng nhập lại thành công, bot hoạt động tiếp.");
}

// Lắng nghe lệnh /relogin từ Telegram (long-polling, không cần thư viện ngoài)
let offset = 0;
async function poll() {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?timeout=30&offset=${offset}`);
    const d = await r.json();
    for (const u of d.result || []) {
      offset = u.update_id + 1;
      if (u.message?.text?.trim() === "/relogin") {
        try { await relogin(); } catch (e) { await tg("Lỗi relogin: " + e.message); }
      }
    }
  } catch {}
  poll();
}

// ---- Chống gửi trùng: mỗi ngày chỉ gửi đúng 1 lần ----
function todayVN() {
  // ngày hiện tại theo giờ Việt Nam, dạng YYYY-MM-DD
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
}
function alreadySentToday() {
  try { return fs.readFileSync(SENT_FILE, "utf8").trim() === todayVN(); }
  catch { return false; }
}
function markSentToday() {
  fs.writeFileSync(SENT_FILE, todayVN());
}

// Khởi động bot: nạp zca-js, đặt cron, bắt đầu long-poll Telegram, đăng nhập từ cred.json.
async function startZaloBot() {
  if (started) return;
  if (!ENABLED) {
    console.log("[zalo-bot] ZALO_ENABLED=false → bỏ qua, không khởi động bot Zalo.");
    return;
  }
  if (!TG_TOKEN || !TG_CHAT) {
    console.warn("[zalo-bot] Thiếu TELEGRAM_TOKEN/TELEGRAM_CHAT_ID → không khởi động bot Zalo.");
    return;
  }
  try {
    ({ Zalo, ThreadType } = require("zca-js"));
  } catch (e) {
    console.warn("[zalo-bot] Chưa cài 'zca-js' (chạy: npm install zca-js) → bỏ qua bot Zalo.");
    return;
  }
  if (!TARGET_ID) {
    console.warn("[zalo-bot] Thiếu ZALO_TARGET_ID trong .env → bot khởi động nhưng cron sẽ không có người nhận.");
  }
  started = true;

  // Gửi tin mỗi ngày theo CRON_EXPR (mặc định 17h30), giờ Việt Nam
  cron.schedule(CRON_EXPR, async () => {
    if (alreadySentToday()) return;        // đã gửi hôm nay rồi → bỏ qua, không gửi lại
    if (!api) return tg("⚠️ Chưa đăng nhập Zalo. Gửi /relogin để quét QR.");
    if (!TARGET_ID) return tg("⚠️ Chưa cấu hình ZALO_TARGET_ID.");
    try {
      await api.sendMessage({ msg: MESSAGE }, TARGET_ID, ThreadType.User);
      markSentToday();                     // đánh dấu ngay sau khi gửi thành công
      console.log(new Date().toISOString(), "[zalo-bot] đã gửi");
      scheduleNudges(); // bắt đầu theo dõi đối tượng có trả lời không
    } catch (e) {
      await tg(`⚠️ Gửi Zalo thất bại: ${e.message}\nGửi /relogin để khôi phục.`);
    }
  }, { timezone: "Asia/Ho_Chi_Minh" });

  poll();
  try { await loginFromFile(); console.log("[zalo-bot] đã đăng nhập từ cred.json"); }
  catch { await tg("⚠️ Bot Zalo khởi động chưa có session. Gửi /relogin để quét QR."); }
}

module.exports = { startZaloBot };

// Cho phép chạy độc lập để test: `node bot.js`
if (require.main === module) startZaloBot();
