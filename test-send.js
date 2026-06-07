// Test: tìm bạn theo tên và (tùy chọn) gửi tin Zalo.
//   Liệt kê:  node test-send.js "muối"
//   Gửi:      node test-send.js "muối" "Nội dung tin nhắn"
// Chỉ gửi khi tìm thấy ĐÚNG 1 người khớp (tránh gửi nhầm).
const fs = require("fs");
const path = require("path");
const { Zalo, ThreadType } = require("zca-js");

const CRED_FILE = path.join(__dirname, "cred.json");
const keyword = (process.argv[2] || "").toLowerCase();
const message = process.argv[3];

function safeFetch(url, init) {
  if (init && init.headers && typeof init.headers === "object" && !(init.headers instanceof Headers)) {
    const clean = {};
    for (const k of Object.keys(init.headers)) clean[k] = init.headers[k];
    init = { ...init, headers: clean };
  }
  return fetch(url, init);
}

(async () => {
  if (!fs.existsSync(CRED_FILE)) { console.error("❌ Chưa có cred.json"); process.exit(1); }
  const zalo = new Zalo({ polyfill: safeFetch });
  const api = await zalo.login(JSON.parse(fs.readFileSync(CRED_FILE)));

  const friends = await api.getAllFriends();
  const matches = friends
    .map((f) => ({ userId: f.userId, ten: f.zaloName || f.displayName || "" }))
    .filter((r) => r.ten.toLowerCase().includes(keyword));

  console.log(`Khớp "${keyword}": ${matches.length} người`);
  for (const m of matches) console.log(`  ${m.userId}\t${m.ten}`);

  if (!message) { console.log("\n(Chưa gửi — thêm tham số nội dung để gửi.)"); process.exit(0); }
  if (matches.length !== 1) { console.error(`\n❌ Không gửi: cần đúng 1 người khớp, đang có ${matches.length}.`); process.exit(1); }

  const target = matches[0];
  await api.sendMessage({ msg: message }, target.userId, ThreadType.User);
  console.log(`\n✅ Đã gửi tới ${target.ten} (${target.userId}): "${message}"`);
  process.exit(0);
})().catch((e) => { console.error("Lỗi:", e.message); process.exit(1); });
