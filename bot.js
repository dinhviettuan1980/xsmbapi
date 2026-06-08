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
const FRIENDS_FILE = path.join(__dirname, "friends.json");     // cache danh bạ để FE chọn người nhận
const SCHEDULES_FILE = path.join(__dirname, "schedules.json"); // lịch gửi tin do FE cấu hình

// zca-js được nạp lười (lazy) trong startZaloBot() để việc thiếu thư viện / chưa
// cấu hình không làm sập tiến trình API khi require('./bot').
let Zalo, ThreadType, LoginQRCallbackEventType;
let api = null;
let started = false;
let loggedIn = false;
let lastError = null;
let lastPollOk = null;
let lastQR = null;          // ảnh QR base64 gần nhất (phục vụ đăng nhập qua HTTP)
let reloginRunning = false; // tránh chạy 2 phiên relogin chồng nhau
let lastLoginEvent = null;  // sự kiện QR gần nhất (chẩn đoán riêng, không bị poll ghi đè)
let lastLoginError = null;  // lỗi trong quá trình đăng nhập (tách khỏi lỗi poll Telegram)
let loggedInAt = null;      // thời điểm đăng nhập thành công gần nhất (ISO)
let lastVerifiedAt = null;  // lần cuối xác minh session còn sống (ISO)
let sessionValid = false;   // session còn dùng được không (kiểm bằng fetchAccountInfo)
let accountName = null;     // tên tài khoản Zalo đang đăng nhập (để hiển thị trên FE)

// Trạng thái để chẩn đoán từ xa qua endpoint /zalo/health
function zaloStatus() {
  return {
    enabled: ENABLED,
    started,
    loggedIn,
    sessionValid,
    accountName,
    loggedInAt,
    lastVerifiedAt,
    hasCred: (() => { try { return fs.existsSync(CRED_FILE); } catch { return false; } })(),
    targetId: TARGET_ID ? "set" : "missing",
    cron: CRON_EXPR,
    node: process.version,
    hasFetch: typeof fetch === "function",
    lastPollOk,
    lastError,
    reloginRunning,
    lastLoginEvent,
    lastLoginError,
    now: new Date().toISOString(),
  };
}

// Bug zca-js + undici (Node 20.15): khi xử lý redirect, một property khóa-Symbol
// rò rỉ từ Headers vào object headers → undici ném "Could not convert argument of
// type symbol to string". Polyfill này dựng lại headers chỉ từ khóa chuỗi rồi gọi
// fetch chuẩn (vẫn là undici nên getSetCookie() hoạt động, cookie login không mất).
function safeFetch(url, init) {
  if (init && init.headers && typeof init.headers === "object" && !(init.headers instanceof Headers)) {
    const clean = {};
    for (const k of Object.keys(init.headers)) clean[k] = init.headers[k];
    init = { ...init, headers: clean };
  }
  return fetch(url, init);
}
function newZalo() {
  return new Zalo({ polyfill: safeFetch });
}

async function tg(text) {
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text }),
  }).catch(() => {});
}

// zca-js 2.x trả ảnh QR dạng base64 (không phải đường dẫn file) → gửi thẳng lên Telegram.
async function sendQRImage(base64) {
  const form = new FormData();
  form.append("chat_id", TG_CHAT);
  form.append("photo", new Blob([Buffer.from(base64, "base64")]), "qr.png");
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
  const zalo = newZalo();
  api = await zalo.login(cred);
  attachListener();
  api.listener.start();
  loggedIn = true;
  loggedInAt = new Date().toISOString();
  await verifySession(); // xác minh ngay để biết cred.json còn hạn không
}

// Xác minh session còn sống bằng một API nhẹ (fetchAccountInfo). Trả true/false và
// cập nhật sessionValid + lastVerifiedAt. Khi phát hiện hết hạn thì báo Telegram 1 lần.
async function verifySession() {
  if (!api) { sessionValid = false; return false; }
  const wasValid = sessionValid;
  try {
    if (typeof api.fetchAccountInfo === "function") {
      const info = await api.fetchAccountInfo();
      accountName = info?.profile?.displayName || info?.profile?.zaloName || accountName;
    }
    sessionValid = true;
    lastVerifiedAt = new Date().toISOString();
    return true;
  } catch (e) {
    sessionValid = false;
    lastVerifiedAt = new Date().toISOString();
    lastLoginError = "verify: " + (e?.message || e);
    if (wasValid) await tg("🔴 Session Zalo đã HẾT HẠN. Vào trang quản trị (hoặc gửi /relogin) để quét QR đăng nhập lại.");
    return false;
  }
}

async function relogin() {
  await tg("Đang tạo QR mới…");
  try { api?.listener.stop(); } catch {}
  const zalo = newZalo();
  const T = LoginQRCallbackEventType;
  let cred = null;
  api = await zalo.loginQR({}, async (ev) => {
    // QUAN TRỌNG: mọi thao tác Telegram phải bọc try/catch — server bị chặn Telegram,
    // nếu để ném lỗi ra khỏi callback sẽ phá vỡ luồng đăng nhập Zalo.
    try {
      switch (ev.type) {
        case T.QRCodeGenerated:
          lastQR = ev.data.image;          // lưu để lấy qua endpoint /zalo/qr
          lastLoginEvent = "QRCodeGenerated @ " + new Date().toISOString();
          await sendQRImage(ev.data.image); // best-effort
          await tg("📷 Quét mã QR ở trên bằng app Zalo để đăng nhập.");
          break;
        case T.QRCodeExpired:
          lastLoginEvent = "QRCodeExpired @ " + new Date().toISOString();
          await tg("⌛ Mã QR đã hết hạn. Lấy mã mới.");
          break;
        case T.QRCodeScanned:
          lastLoginEvent = "QRCodeScanned @ " + new Date().toISOString();
          await tg(`👀 Đã quét QR${ev.data?.display_name ? " (" + ev.data.display_name + ")" : ""}, đang hoàn tất…`);
          break;
        case T.QRCodeDeclined:
          lastLoginEvent = "QRCodeDeclined @ " + new Date().toISOString();
          await tg("❌ Đăng nhập bị từ chối trên điện thoại.");
          break;
        case T.GotLoginInfo:
          // Thông tin session để đăng nhập lại lần sau (không phải api.getContext() như zca-js cũ)
          cred = { imei: ev.data.imei, cookie: ev.data.cookie, userAgent: ev.data.userAgent };
          lastLoginEvent = "GotLoginInfo @ " + new Date().toISOString();
          break;
      }
    } catch (e) { lastLoginError = "callback(" + ev.type + "): " + (e?.message || e); }
  });
  if (cred) { fs.writeFileSync(CRED_FILE, JSON.stringify(cred)); }
  else { lastLoginError = "GotLoginInfo không tới — không có cred để lưu"; await tg("⚠️ Không lấy được session."); }
  attachListener();
  api.listener.start();
  loggedIn = true;
  loggedInAt = new Date().toISOString();
  await verifySession();
  await tg("✅ Đăng nhập lại thành công, bot hoạt động tiếp.");
}

// Kích hoạt đăng nhập lại (chạy nền). QR sẽ có ở getLastQR()/Telegram.
async function triggerRelogin() {
  if (reloginRunning) return { running: true };
  reloginRunning = true;
  lastQR = null;
  lastLoginError = null;
  relogin()
    .catch((e) => { lastLoginError = "relogin: " + (e?.message || e); })
    .finally(() => { reloginRunning = false; });
  return { started: true };
}
function getLastQR() { return lastQR; }

// Gửi ngay ZALO_MESSAGE tới ZALO_TARGET_ID (để test end-to-end, không đợi cron)
async function sendTestMessage() {
  if (!api) return { ok: false, error: "chưa đăng nhập Zalo" };
  if (!TARGET_ID) return { ok: false, error: "thiếu ZALO_TARGET_ID" };
  try {
    await api.sendMessage({ msg: MESSAGE }, TARGET_ID, ThreadType.User);
    return { ok: true, to: TARGET_ID, msg: MESSAGE };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Gửi tin tới một người bất kỳ (dùng cho lịch hẹn và nút "gửi thử" trên FE)
async function sendMessageTo(targetId, message) {
  if (!api) return { ok: false, error: "chưa đăng nhập Zalo" };
  if (!targetId) return { ok: false, error: "thiếu targetId" };
  if (!message) return { ok: false, error: "thiếu nội dung" };
  try {
    await api.sendMessage({ msg: String(message) }, String(targetId), ThreadType.User);
    return { ok: true, to: targetId };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// ---- Danh bạ Zalo (cache ra file để FE chọn người nhận) ----
function readFriendsCache() {
  try { return JSON.parse(fs.readFileSync(FRIENDS_FILE, "utf8")); }
  catch { return { updatedAt: null, friends: [] }; }
}
// Lấy danh bạ. force=true thì gọi Zalo lấy mới, ngược lại trả cache nếu có.
async function listFriends({ force = false } = {}) {
  const cache = readFriendsCache();
  if (!force && cache.friends.length) return cache;
  if (!api) return { ...cache, error: "chưa đăng nhập Zalo" };
  try {
    const raw = await api.getAllFriends();
    const friends = (raw || []).map((f) => ({
      userId: f.userId,
      name: f.zaloName || f.displayName || "",
      avatar: f.avatar || "",
    })).filter((f) => f.userId);
    const out = { updatedAt: new Date().toISOString(), friends };
    fs.writeFileSync(FRIENDS_FILE, JSON.stringify(out));
    return out;
  } catch (e) {
    return { ...cache, error: e?.message || String(e) };
  }
}

// ---- Lịch gửi tin do FE cấu hình ----
// Mỗi lịch: { id, targetId, targetName, message, time:"HH:MM", days:[0..6] (rỗng=mỗi ngày),
//             enabled:bool, lastSentDate:"YYYY-MM-DD", createdAt }
function loadSchedules() {
  try { return JSON.parse(fs.readFileSync(SCHEDULES_FILE, "utf8")); }
  catch { return []; }
}
function saveSchedules(list) {
  fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(list, null, 2));
}
function getSchedules() { return loadSchedules(); }
function addSchedule(s) {
  const list = loadSchedules();
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    targetId: String(s.targetId || ""),
    targetName: s.targetName || "",
    message: s.message || "",
    time: /^\d{1,2}:\d{2}$/.test(s.time || "") ? s.time : "08:00",
    days: Array.isArray(s.days) ? s.days.map(Number).filter((d) => d >= 0 && d <= 6) : [],
    enabled: s.enabled !== false,
    lastSentDate: null,
    createdAt: new Date().toISOString(),
  };
  list.push(item);
  saveSchedules(list);
  return item;
}
function updateSchedule(id, patch) {
  const list = loadSchedules();
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const allowed = ["targetId", "targetName", "message", "time", "days", "enabled"];
  for (const k of allowed) if (k in patch) list[i][k] = patch[k];
  if ("days" in patch) list[i].days = Array.isArray(patch.days) ? patch.days.map(Number) : [];
  saveSchedules(list);
  return list[i];
}
function deleteSchedule(id) {
  const list = loadSchedules();
  const next = list.filter((x) => x.id !== id);
  saveSchedules(next);
  return { deleted: list.length - next.length };
}
// Giờ:phút và thứ hiện tại theo giờ Việt Nam
function nowVNParts() {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const wmap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { hm: `${parts.hour}:${parts.minute}`, day: wmap[parts.weekday] };
}
// Chạy mỗi phút: gửi các lịch khớp giờ hiện tại, chống gửi trùng trong ngày.
async function runScheduleTick() {
  const list = loadSchedules();
  if (!list.length) return;
  const { hm, day } = nowVNParts();
  const today = todayVN();
  let changed = false;
  for (const s of list) {
    if (!s.enabled || !s.targetId || !s.message) continue;
    if ((s.time || "").padStart(5, "0") !== hm) continue;
    if (s.days && s.days.length && !s.days.includes(day)) continue;
    if (s.lastSentDate === today) continue; // đã gửi hôm nay
    const r = await sendMessageTo(s.targetId, s.message);
    if (r.ok) {
      s.lastSentDate = today;
      changed = true;
      await tg(`📨 Đã gửi lịch hẹn tới ${s.targetName || s.targetId} lúc ${hm}.`);
    } else {
      await tg(`⚠️ Lịch hẹn tới ${s.targetName || s.targetId} thất bại: ${r.error}`);
    }
  }
  if (changed) saveSchedules(list);
}

// Lắng nghe lệnh /relogin từ Telegram (long-polling, không cần thư viện ngoài)
let offset = 0;
async function poll() {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?timeout=30&offset=${offset}`);
    const d = await r.json();
    lastPollOk = new Date().toISOString();
    for (const u of d.result || []) {
      offset = u.update_id + 1;
      if (u.message?.text?.trim() === "/relogin") {
        try { await triggerRelogin(); } catch (e) { lastError = "relogin: " + e.message; await tg("Lỗi relogin: " + e.message); }
      }
    }
    poll();                       // thành công → tiếp tục long-poll ngay
  } catch (e) {
    lastError = "poll: " + (e?.message || e);
    setTimeout(poll, 15000);      // lỗi (vd server chặn Telegram) → chờ 15s rồi thử lại, tránh quay vòng tốc độ cao
  }
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
    ({ Zalo, ThreadType, LoginQRCallbackEventType } = require("zca-js"));
  } catch (e) {
    lastError = "require zca-js: " + (e?.message || e);
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

  // Lịch hẹn do FE cấu hình: kiểm mỗi phút
  cron.schedule("* * * * *", () => { runScheduleTick().catch((e) => { lastError = "schedule: " + (e?.message || e); }); }, { timezone: "Asia/Ho_Chi_Minh" });

  // Xác minh session còn sống mỗi 20 phút → phát hiện hết hạn sớm, báo Telegram
  cron.schedule("*/20 * * * *", () => { verifySession().catch(() => {}); });

  poll();
  try { await loginFromFile(); console.log("[zalo-bot] đã đăng nhập từ cred.json"); }
  catch (e) { lastError = "loginFromFile: " + (e?.message || e); await tg("⚠️ Bot Zalo khởi động chưa có session. Gửi /relogin để quét QR."); }
}

module.exports = {
  startZaloBot, zaloStatus, triggerRelogin, getLastQR, sendTestMessage,
  verifySession, listFriends, sendMessageTo,
  getSchedules, addSchedule, updateSchedule, deleteSchedule,
};

// Cho phép chạy độc lập để test: `node bot.js`
if (require.main === module) startZaloBot();
