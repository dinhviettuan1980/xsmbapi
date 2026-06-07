// Liệt kê bạn bè Zalo (userId + tên) để lấy ZALO_TARGET_ID cho bot.
// Cần đã có cred.json (sinh ra sau lần /relogin đầu tiên của bot).
// Chạy: node list-friends.js   (hoặc: node list-friends.js <chuỗi-tìm-theo-tên>)
const fs = require("fs");
const path = require("path");
const { Zalo } = require("zca-js");

const CRED_FILE = path.join(__dirname, "cred.json");
const keyword = (process.argv[2] || "").toLowerCase();

(async () => {
  if (!fs.existsSync(CRED_FILE)) {
    console.error("❌ Chưa có cred.json. Hãy đăng nhập trước:");
    console.error("   - Bật bot (ZALO_ENABLED=true), chạy API, gửi /relogin trong Telegram, quét QR.");
    console.error("   - Hoặc chạy `npm run bot` rồi gửi /relogin.");
    process.exit(1);
  }
  const cred = JSON.parse(fs.readFileSync(CRED_FILE));
  const zalo = new Zalo();
  const api = await zalo.login(cred);

  const friends = await api.getAllFriends();
  const rows = friends
    .map((f) => ({ userId: f.userId, ten: f.zaloName || f.displayName || "" }))
    .filter((r) => !keyword || r.ten.toLowerCase().includes(keyword));

  console.log(`Tìm thấy ${rows.length}/${friends.length} bạn bè` + (keyword ? ` khớp "${keyword}"` : "") + ":\n");
  for (const r of rows) console.log(`${r.userId}\t${r.ten}`);

  console.log(`\n👉 Copy userId của đúng người vào ZALO_TARGET_ID trong .env`);
  process.exit(0);
})().catch((e) => {
  console.error("Lỗi:", e.message);
  process.exit(1);
});
