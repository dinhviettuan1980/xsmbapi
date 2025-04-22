const axios = require('axios');
const cheerio = require('cheerio');
const db = require('./db');
const sendTelegramMessage = require('./telegram');

async function fetchAndSaveXSMB() {
  try {
    const { data } = await axios.get('https://ketqua04.net', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const $ = cheerio.load(data);
    const rawDate = $('#result_date').text().trim();
    const dateMatch = rawDate.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
    if (!dateMatch) throw new Error("Không lấy được ngày hợp lệ");
    const dateText = `${dateMatch[3]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[1].padStart(2, '0')}`;
    const result = {};
    for (let i = 0; i <= 7; i++) {
      const values = [];
      $(`div[id^="rs_${i}_"]`).each((_, el) => {
        const val = $(el).text().trim();
        if (val) values.push(val);
      });
      result[`G${i}`] = values.join(',');
    }
    const sql = `
      INSERT INTO xsmb (result_date, g0, g1, g2, g3, g4, g5, g6, g7)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        g0=VALUES(g0), g1=VALUES(g1), g2=VALUES(g2), g3=VALUES(g3),
        g4=VALUES(g4), g5=VALUES(g5), g6=VALUES(g6), g7=VALUES(g7)
    `;
    await db.execute(sql, [
      dateText,
      result.G0, result.G1, result.G2, result.G3,
      result.G4, result.G5, result.G6, result.G7
    ]);
    const message = `🎯 KQ XSMB ${dateText}
Đặc biệt: ${result.G0}
Giải nhất: ${result.G1}
Giải nhì: ${result.G2}
Giải ba: ${result.G3}
Giải tư: ${result.G4}
Giải năm: ${result.G5}
Giải sáu: ${result.G6}
Giải bảy: ${result.G7}`;
    await sendTelegramMessage(message);
    console.log(`[OK] Đã lưu kết quả XSMB ngày ${dateText}`);
  } catch (err) {
    console.error('[ERROR]', err.message);
  }
}
module.exports = fetchAndSaveXSMB;
