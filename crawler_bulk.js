const axios = require('axios');
const cheerio = require('cheerio');
const db = require('./db');

function splitByLength(text, count, length) {
  return text.match(new RegExp(`\\d{${length}}`, 'g'))?.slice(0, count).join(',') || '';
}

async function fetchBulkXSMB() {
  try {
    const { data } = await axios.get('https://ketqua04.net/so-ket-qua-truyen-thong/300', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const $ = cheerio.load(data);
    const tables = $('table');

    tables.each(async (_, table) => {
      const $table = $(table);
      const heading = $table.find('tr').first().text();
      const match = heading.match(/ngày (\d{2})-(\d{2})-(\d{4})/);
      if (!match) return;

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
        const sql = `
          INSERT INTO xsmb (result_date, g0, g1, g2, g3, g4, g5, g6, g7)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            g0=VALUES(g0), g1=VALUES(g1), g2=VALUES(g2), g3=VALUES(g3),
            g4=VALUES(g4), g5=VALUES(g5), g6=VALUES(g6), g7=VALUES(g7)
        `;

        await db.execute(sql, [
          result.result_date,
          result.g0 || '', result.g1 || '', result.g2 || '', result.g3 || '',
          result.g4 || '', result.g5 || '', result.g6 || '', result.g7 || ''
        ]);
        console.log(`✅ Saved ${result.result_date}`);
      }
    });
  } catch (err) {
    console.error('[ERROR]', err.message);
  }
}

module.exports = fetchBulkXSMB;
