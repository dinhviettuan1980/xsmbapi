const axios = require('axios');
const cheerio = require('cheerio');
const dbPromise = require('./db');

function splitByLength(text, count, length) {
  return text.match(new RegExp(`\\d{${length}}`, 'g'))?.slice(0, count).join(',') || '';
}

async function fetchBulkXSMB() {
  try {
    const db = await dbPromise;

    const { data } = await axios.get('https://ketqua04.net/so-ket-qua-truyen-thong/300', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const $ = cheerio.load(data);

    // duyệt từng block kết quả
    $('div.result_div#result_mb').each(async (_, el) => {
      // LẤY NGÀY: trong page.html ngày nằm tại span#result_date
      const dateText = $(el).find('#result_date').text().trim();
      if (!dateText) return;
      // debug nhanh:
      // console.log('DEBUG dateText=', dateText);

      const match = dateText.match(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
      if (!match) return;

      const result_date = `${match[3]}-${match[2]}-${match[1]}`;
      const result = { result_date };

      // duyệt từng hàng trong bảng kết quả
      $(el).find('#result_tab_mb tbody tr').each((_, row) => {
        const tds = $(row).find('td');
        if (tds.length < 2) return;
        const label = $(tds[0]).text().trim().replace(/\s+/g, ' ');
        // value có thể nằm trong div bên trong td (ví dụ id="rs_0_0"), hoặc text trực tiếp
        const rawValue = $(tds[1]).text().trim();
        const digits = rawValue.replace(/[^0-9]/g, ''); // chỉ lấy số liên tiếp

        if (/Đặc biệt/i.test(label)) {
          result.g0 = splitByLength(digits, 1, 5);
        } else if (/Giải nhất/i.test(label)) {
          result.g1 = splitByLength(digits, 1, 5);
        } else if (/Giải nhì/i.test(label)) {
          result.g2 = splitByLength(digits, 2, 5);
        } else if (/Giải ba/i.test(label)) {
          result.g3 = splitByLength(digits, 6, 5);
        } else if (/Giải tư/i.test(label)) {
          result.g4 = splitByLength(digits, 4, 4);
        } else if (/Giải năm/i.test(label)) {
          result.g5 = splitByLength(digits, 6, 4);
        } else if (/Giải sáu/i.test(label)) {
          result.g6 = splitByLength(digits, 3, 3);
        } else if (/Giải bảy/i.test(label)) {
          result.g7 = splitByLength(digits, 4, 2);
        }
      });

      // lưu nếu có g0
      if (result.g0) {
        const exists = await db.get('SELECT 1 FROM xsmb WHERE result_date = ?', [result.result_date]);

        if (exists) {
          await db.run(
            `UPDATE xsmb SET g0=?, g1=?, g2=?, g3=?, g4=?, g5=?, g6=?, g7=? WHERE result_date = ?`,
            [
              result.g0 || '', result.g1 || '', result.g2 || '', result.g3 || '',
              result.g4 || '', result.g5 || '', result.g6 || '', result.g7 || '',
              result.result_date
            ]
          );
        } else {
          await db.run(
            `INSERT INTO xsmb (result_date, g0, g1, g2, g3, g4, g5, g6, g7)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              result.result_date,
              result.g0 || '', result.g1 || '', result.g2 || '', result.g3 || '',
              result.g4 || '', result.g5 || '', result.g6 || '', result.g7 || ''
            ]
          );
        }

        console.log(`✅ Saved ${result.result_date}`);
      } else {
        console.log(`ℹ️ Skipped ${result.result_date} (no g0 parsed)`);
      }
    });
  } catch (err) {
    console.error('[ERROR]', err.message);
  }
}

module.exports = fetchBulkXSMB;
