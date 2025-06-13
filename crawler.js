const axios = require('axios');
const cheerio = require('cheerio');
const dbPromise = require('./db');
const sendTelegramMessage = require('./telegram');

async function fetchAndSaveXSMB() {
  try {
    const db = await dbPromise;

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

    const existing = await db.get('SELECT 1 FROM xsmb WHERE result_date = ?', [dateText]);

    if (existing) {
      await db.run(
        `UPDATE xsmb SET g0=?, g1=?, g2=?, g3=?, g4=?, g5=?, g6=?, g7=? WHERE result_date = ?`,
        [result.G0, result.G1, result.G2, result.G3, result.G4, result.G5, result.G6, result.G7, dateText]
      );
    } else {
      await db.run(
        `INSERT INTO xsmb (result_date, g0, g1, g2, g3, g4, g5, g6, g7)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [dateText, result.G0, result.G1, result.G2, result.G3, result.G4, result.G5, result.G6, result.G7]
      );
    }

    const message = `🎯 KQ XSMB ${dateText}\n`
      + `Đặc biệt: ${result.G0}\n`
      + `Giải nhất: ${result.G1}\n`
      + `Giải nhì: ${result.G2}\n`
      + `Giải ba: ${result.G3}\n`
      + `Giải tư: ${result.G4}\n`
      + `Giải năm: ${result.G5}\n`
      + `Giải sáu: ${result.G6}\n`
      + `Giải bảy: ${result.G7}`;

    await sendTelegramMessage(message);
    console.log(`[OK] Đã lưu kết quả XSMB ngày ${dateText}`);
  } catch (err) {
    console.error('[ERROR]', err.message);
  }
}

module.exports = fetchAndSaveXSMB;
