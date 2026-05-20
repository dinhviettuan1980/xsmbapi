const axios = require('axios');
const cheerio = require('cheerio');
const dbPromise = require('./db');
const sendTelegramMessage = require('./telegram');

const PRIZE_EXPECTED = { G0: 1, G1: 1, G2: 2, G3: 6, G4: 4, G5: 6, G6: 3, G7: 4 };

// Thứ tự giải trong raw data: g7,g6,g5,g4,g3,g2,g1,g0 (index 2-9)
const RAW_ORDER = ['G7', 'G6', 'G5', 'G4', 'G3', 'G2', 'G1', 'G0'];

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

    const baseUrl = process.env.RESULT_BASE_URL || 'https://ketqua07.net';
    console.log(`${tag} Fetching ${baseUrl}...`);
    let pageResponse;
    try {
      pageResponse = await axios.get(baseUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 10000,
      });
    } catch (fetchErr) {
      console.error(`${tag} HTTP request failed: ${fetchErr.message}`);
      return 0;
    }

    const $ = cheerio.load(pageResponse.data);
    const rawDate = $('#result_date').text().trim();
    const dataDomain = $('meta[name="data-server"]').attr('value');

    const dateMatch = rawDate.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
    if (!dateMatch) {
      console.error(`${tag} Cannot parse date from: "${rawDate}"`);
      return 0;
    }

    const dateText = `${dateMatch[3]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[1].padStart(2, '0')}`;
    console.log(`${tag} Date: ${dateText}, data-server: ${dataDomain}`);

    if (!dataDomain) {
      console.error(`${tag} Không tìm thấy meta data-server`);
      return 0;
    }

    // Lấy raw data từ API
    let rawData;
    try {
      const rawUrl = `https://${dataDomain}/pre_loads/kq-mb.raw`;
      const rawResponse = await axios.get(rawUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': `${baseUrl}/` },
        timeout: 10000,
      });
      rawData = typeof rawResponse.data === 'string' ? rawResponse.data : JSON.stringify(rawResponse.data);
    } catch (rawErr) {
      console.error(`${tag} Raw API failed: ${rawErr.message}`);
      return 0;
    }

    // Parse: timestamp;positions;g7;g6;g5;g4;g3;g2;g1;g0
    const parts = rawData.trim().split(';');
    const result = {};
    const prizeSummary = [];

    for (let i = 0; i < RAW_ORDER.length; i++) {
      const key = RAW_ORDER[i];
      const raw = parts[i + 2] || '';
      const values = raw ? raw.split('-').map(s => s.trim()).filter(s => /^\d+$/.test(s)) : [];
      result[key] = values.join(',');
      prizeSummary.push(`g${key[1]}=${values.length}/${PRIZE_EXPECTED[key]}[${values.join('|')}]`);
    }

    console.log(`${tag} Prizes: ${prizeSummary.join(' ')}`);

    const existing = await db.get('SELECT 1 FROM xsmb WHERE result_date = ?', [dateText]);

    if (existing) {
      const updates = [];
      const params = [];
      for (let i = 0; i <= 7; i++) {
        if (result[`G${i}`]) {
          updates.push(`g${i}=?`);
          params.push(result[`G${i}`]);
        }
      }
      if (updates.length > 0) {
        params.push(dateText);
        await db.run(`UPDATE xsmb SET ${updates.join(',')} WHERE result_date = ?`, params);
      }
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
