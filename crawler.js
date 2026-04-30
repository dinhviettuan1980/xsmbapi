const axios = require('axios');
const cheerio = require('cheerio');
const dbPromise = require('./db');
const sendTelegramMessage = require('./telegram');

const PRIZE_EXPECTED = { G0: 1, G1: 1, G2: 2, G3: 6, G4: 4, G5: 6, G6: 3, G7: 4 };

function countFilledPrizes(result) {
  let count = 0;
  for (const key of Object.keys(PRIZE_EXPECTED)) {
    if (result[key]) {
      count += result[key].split(',').map(s => s.trim()).filter(Boolean).length;
    }
  }
  return count;
}

async function fetchAndSaveXSMB(options = {}) {
  const { silent = false } = options;
  const tag = silent ? '[LIVE]' : '[CRAWL]';
  try {
    const db = await dbPromise;

    console.log(`${tag} Fetching ketqua04.net...`);
    let response;
    try {
      response = await axios.get('https://ketqua04.net', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 10000,
      });
    } catch (fetchErr) {
      console.error(`${tag} HTTP request failed: ${fetchErr.message}`);
      return 0;
    }

    console.log(`${tag} HTTP ${response.status}, body size: ${response.data.length} bytes`);

    const $ = cheerio.load(response.data);
    const rawDate = $('#result_date').text().trim();
    console.log(`${tag} #result_date text: "${rawDate}"`);

    const dateMatch = rawDate.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
    if (!dateMatch) {
      console.error(`${tag} Cannot parse date from: "${rawDate}"`);
      return 0;
    }

    const dateText = `${dateMatch[3]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[1].padStart(2, '0')}`;
    console.log(`${tag} Date: ${dateText}`);

    const result = {};
    const prizeSummary = [];
    for (let i = 0; i <= 7; i++) {
      const values = [];
      $(`div[id^="rs_${i}_"]`).each((_, el) => {
        const val = $(el).text().trim();
        if (val) values.push(val);
      });
      result[`G${i}`] = values.join(',');
      prizeSummary.push(`g${i}=${values.length}/${PRIZE_EXPECTED[`G${i}`]}[${values.join('|')}]`);
    }
    console.log(`${tag} Prizes: ${prizeSummary.join(' ')}`);

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

    const filled = countFilledPrizes(result);
    console.log(`${tag} Saved ${dateText} — filled: ${filled}/27`);

    if (!silent) {
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
    }

    return filled;
  } catch (err) {
    console.error(`${tag} Unexpected error: ${err.message}`);
    return 0;
  }
}

module.exports = fetchAndSaveXSMB;
