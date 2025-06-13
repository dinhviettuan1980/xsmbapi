const axios = require('axios');
const cheerio = require('cheerio');
const dbPromise = require('./db');

function splitByLength(text, count, length) {
  return text.match(new RegExp(`\d{${length}}`, 'g'))?.slice(0, count).join(',') || '';
}

async function fetchBulkXSMB() {
  try {
    const db = await dbPromise;

    const { data } = await axios.get('https://ketqua04.net/so-ket-qua-truyen-thong/300', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const $ = cheerio.load(data);
    const tables = $('table');

    for (const table of tables) {
      const $table = $(table);
      const heading = $table.find('tr').first().text();
      const match = heading.match(/ngày (\d{2})-(\d{2})-(\d{4})/);
      if (!match) continue;

      const result_date = `${match[3]}-${match[2]}-${match[1]}`;
      const result = { result_date };

      $table.find('tr').slice(1).each((_, row) => {
        const cells = $(row).find('td');
        const label = $(cells[0]).text().trim();
        const digits = $(cells).slice(1).text().replace(/[^\d]/g, '');

        if (label.includes('Đặc biệt')) result.g0 = splitByLength(digits, 1, 5);
        else if (label.includes('Giải nhất')) result.g1 = splitByLength(digits, 1, 5);
        else if (label.includes('Giải nhì')) result.g2 = splitByLength(digits, 2, 5);
        else if (label.includes('Giải ba')) result.g3 = splitByLength(digits, 6, 5);
        else if (label.includes('Giải tư')) result.g4 = splitByLength(digits, 4, 4);
        else if (label.includes('Giải năm')) result.g5 = splitByLength(digits, 6, 4);
        else if (label.includes('Giải sáu')) result.g6 = splitByLength(digits, 3, 3);
        else if (label.includes('Giải bảy')) result.g7 = splitByLength(digits, 4, 2);
      });

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
      }
    }
  } catch (err) {
    console.error('[ERROR]', err.message);
  }
}

module.exports = fetchBulkXSMB;
