# Zalo Daily Bot — ghi chú bàn giao (đầy đủ)

> File này tự chứa: đọc xong là dựng lại được toàn bộ, không cần xem lịch sử chat.
> Mở Claude Code trong repo và bảo "đọc README_zalo_bot.md" là nắm hết đầu đuôi.

## ✅ Đã ráp vào xsmbapi (cập nhật)
Bot đã được nhúng vào API thay vì chạy tiến trình riêng:
- `bot.js` giờ là **module** export `startZaloBot()`; cấu hình đọc từ `.env`
  (`ZALO_TARGET_ID`, `ZALO_MESSAGE`, `ZALO_CRON`, `ZALO_ENABLED`), dùng chung
  `TELEGRAM_TOKEN` / `TELEGRAM_CHAT_ID` với phần còn lại của project.
- `index.js` gọi `startZaloBot()` ngay sau khi server lắng nghe (trong `app.listen`).
  Nếu chưa cài `zca-js`, thiếu cấu hình, hoặc `ZALO_ENABLED=false` thì tự bỏ qua,
  **không** làm sập API.
- Vẫn chạy độc lập được để test: `npm run bot` (tức `node bot.js`).
- Bật bot: điền `ZALO_TARGET_ID`, `ZALO_MESSAGE` rồi đặt `ZALO_ENABLED=true` trong `.env`.
- `cred.json` và `last_sent.txt` đã được thêm vào `.gitignore`.
- Vì đã nhúng, chỉ cần **một** service cho cả API + bot (xem `zalo-bot.service`),
  không chạy `bot.js` song song nữa.

Phần dưới là ghi chú gốc (kiến trúc tiến trình riêng) — giữ lại để tham khảo.

## Mục tiêu
Mỗi ngày **17h30 (5h30 chiều, giờ Việt Nam)** tự động gửi MỘT tin nhắn tới MỘT
người trên Zalo, dùng **tài khoản Zalo cá nhân**. Chạy trên server Ubuntu, miễn
phí, thao tác tay tối thiểu.

## Vì sao làm như thế này
- Zalo **không có API chính thức** cho tài khoản cá nhân nhắn tới bạn bè → dùng
  thư viện không chính thức `zca-js` (đăng nhập QR, lưu session ra `cred.json`).
- Rủi ro: vi phạm ToS Zalo, tài khoản có thể bị khóa. Chấp nhận đánh đổi.
- Session Zalo **hết hạn theo chu kỳ** → cần đăng nhập lại với thao tác tối thiểu
  (bot gửi ảnh QR qua Telegram, chủ quét bằng app Zalo).

## Kiến trúc
Một tiến trình chạy nền duy nhất `bot.js`, giữ sống bằng `systemd`:
- Khởi động: đăng nhập từ `cred.json`, gắn listener, giữ session ấm.
- `node-cron` bắn 17h30 (timezone `Asia/Ho_Chi_Minh`) → gửi tin.
- **Chống gửi trùng**: đối chiếu `last_sent.txt`, mỗi ngày chỉ gửi đúng 1 lần.
- **Theo dõi trả lời**: gửi xong hẹn nhắc ở phút 20/25/30; nếu đối tượng trả lời
  thì hủy hết nhắc; sau phút 30 thì thôi.
- **Nghe lệnh `/relogin`** từ Telegram (long-poll) → tạo QR mới, gửi vào Telegram.
- Gửi lỗi (thường do session chết) → cảnh báo Telegram.

```
systemd ── bot.js ──┬── cron 17h30 ── (chưa gửi hôm nay?) ──> sendMessage ──> hẹn nhắc 20/25/30'
                    ├── listener ── đối tượng trả lời ──> hủy nhắc
                    ├── telegram poll ── "/relogin" ──> loginQR ──> gửi QR vào TG
                    └── lỗi auth ──> cảnh báo TG
```

## Files
- `bot.js` — tiến trình chính (toàn bộ code ở mục cuối README này).
- `zalo-bot.service` — unit systemd, giữ sống + tự chạy lại khi reboot/crash.
- `cred.json` — sinh sau `/relogin` đầu tiên. **KHÔNG commit** (chứa session đăng nhập).
- `last_sent.txt` — sinh tự động, lưu ngày đã gửi gần nhất. Đừng xóa giữa ngày.

## Cài đặt
```bash
cd <thư-mục-project>
npm install zca-js node-cron        # cần Node 18+ (đã có sẵn fetch/FormData/Blob)
# điền TARGET_ID, MESSAGE, TG_TOKEN, TG_CHAT trong bot.js
sudo cp zalo-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now zalo-bot
```
Lần đầu chưa có `cred.json` → bot nhắn Telegram bảo gửi `/relogin` → quét QR → xong.

## Lấy thông số
- `TG_TOKEN`: tạo bot qua @BotFather.
- `TG_CHAT`: nhắn bot vài câu rồi mở `https://api.telegram.org/bot<TOKEN>/getUpdates`.
- `TARGET_ID`: chạy `api.getAllFriends()` một lần, in `userId` + tên, lấy đúng người.

## Quy tắc vận hành (quan trọng để đảm bảo "100% gửi 1 lần")
- **Chỉ chạy đúng MỘT instance `bot.js`.** systemd lo việc này; đừng tự tay
  `node bot.js` thêm cửa sổ nữa song song với service.
- **Không mở Zalo Web cùng tài khoản** song song — sẽ tự ngắt listener của bot
  (theo tài liệu zca-js), khiến không phát hiện được tin trả lời.

## Việc còn phải kiểm tra (chưa xác nhận)
1. Đường dẫn `node` thật trên server (`which node`) — sửa trong `zalo-bot.service`
   nếu khác `/usr/bin/node`. Cũng sửa `WorkingDirectory` và `User` cho đúng.
2. Tên field trong `api.getContext()` (`cookie`/`imei`/`userAgent`) — `zca-js`
   thỉnh thoảng đổi; log ra xem một lần, lệch thì sửa đoạn lưu `cred.json`.

## Tùy chọn tích hợp xsmbapi (CHƯA làm)
Nếu muốn nội dung 17h30 lấy động từ xsmbapi (vd kết quả xổ số) thay vì tin tĩnh:
thay hằng `MESSAGE` bằng một hàm async gọi API xsmbapi trả về chuỗi, gọi ngay
trước `sendMessage`. Lưu ý: XSMB thường có kết quả ~18h15, muộn hơn 17h30 — nếu
mục đích là gửi kết quả thì cân nhắc dời mốc giờ sang ~18h30–19h.

---

## bot.js (bản đầy đủ)
```js
const { Zalo, ThreadType } = require("zca-js");
const cron = require("node-cron");
const fs = require("fs");

const TARGET_ID = "userId_người_nhận";
const MESSAGE   = "Nội dung tin nhắn của bạn";
const TG_TOKEN  = "telegram_bot_token";
const TG_CHAT   = "telegram_chat_id";

let api = null;

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
  const cred = JSON.parse(fs.readFileSync("cred.json"));
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
  fs.writeFileSync("cred.json", JSON.stringify({ cookie: c.cookie, imei: c.imei, userAgent: c.userAgent }));
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
const SENT_FILE = "last_sent.txt";
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

// Gửi tin 17h30 (5h30 chiều) mỗi ngày, giờ Việt Nam
cron.schedule("30 17 * * *", async () => {
  if (alreadySentToday()) return;        // đã gửi hôm nay rồi → bỏ qua, không gửi lại
  if (!api) return tg("⚠️ Chưa đăng nhập. Gửi /relogin để quét QR.");
  try {
    await api.sendMessage({ msg: MESSAGE }, TARGET_ID, ThreadType.User);
    markSentToday();                     // đánh dấu ngay sau khi gửi thành công
    console.log(new Date().toISOString(), "đã gửi");
    scheduleNudges(); // bắt đầu theo dõi đối tượng có trả lời không
  } catch (e) {
    await tg(`⚠️ Gửi thất bại: ${e.message}\nGửi /relogin để khôi phục.`);
  }
}, { timezone: "Asia/Ho_Chi_Minh" });

(async () => {
  poll();
  try { await loginFromFile(); console.log("đã đăng nhập từ cred.json"); }
  catch { await tg("⚠️ Khởi động chưa có session. Gửi /relogin để quét QR."); }
})();
```

## zalo-bot.service (bản đầy đủ)
```ini
[Unit]
Description=Zalo daily bot
After=network.target

[Service]
WorkingDirectory=/home/ban/zalo-bot
ExecStart=/usr/bin/node bot.js
Restart=always
RestartSec=10
User=ban

[Install]
WantedBy=multi-user.target
```
