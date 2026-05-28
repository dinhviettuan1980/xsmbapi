const express = require('express');
const multer = require('multer');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');
const cron = require('node-cron');
const fetchAndSaveXSMB = require('./crawler');
const fetchBulkXSMB = require('./crawler_bulk');
const sendTelegramMessage = require('./telegram');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const dayjs = require("dayjs");
const dbPromise = require('./db');
require('dotenv').config();
const cors = require('cors');
const combinationRoute = require('./combination');
const combinationAdvancedRoute = require('./combination-advanced');
const classifyRoute = require('./classify-two-digit');
const specialsRoute = require('./specials');
const verifyGoogleToken = require('./middlewares/authMiddleware');
const getServerInfo = require('./serverInfo');
const storageRouter = require('./storage-router');

const app = express();
const PORT = process.env.PORT;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;

// Thiết lập nơi lưu ảnh tạm thời
const upload = multer({ dest: 'uploads/' });

app.use(cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(combinationRoute);
app.use(combinationAdvancedRoute);
app.use(classifyRoute);
app.use(specialsRoute);
app.use('/storage', storageRouter);




app.get('/', (req, res) => {
  res.send('XSMB API is running');
});

app.get('/api/history', async (req, res) => {
  const db = await dbPromise;
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: "Missing 'date' query param" });

  try {
    const rows = await db.all('SELECT * FROM xsmb WHERE result_date = ?', [date]);
    const result = rows[0];

    if (!result) return res.json({ message: 'Không có dữ liệu' });

    // Gom toàn bộ số từ g0 đến g7
    const all = [];
    for (let i = 0; i <= 7; i++) {
      const field = 'g' + i;
      if (result[field]) {
        const nums = result[field].split(',').map(s => s.trim()).filter(Boolean);
        all.push(...nums);
      }
    }

    // Lấy 2 chữ số cuối cùng của mỗi số
    const last2Digits = all
      .map(num => num.slice(-2))
      .filter(n => n.length === 2);

    // Tính thống kê giữ trùng (dùng array thay vì Set)
    const headToTail = {};
    const tailToHead = {};

    for (let i = 0; i <= 9; i++) {
      headToTail[i] = [];
      tailToHead[i] = [];
    }

    last2Digits.forEach(num => {
      const h = num[0];
      const t = num[1];
      headToTail[h].push(t);
      tailToHead[t].push(h);
    });

    // Chuyển về dạng chuỗi giữ trùng
    const formatMap = (map) => {
      const result = {};
      for (let i = 0; i <= 9; i++) {
        const values = map[i];
        result[i] = values.length ? values.join(',') : "-";
      }
      return result;
    };

    res.json({
      ...result,
      headToTail: formatMap(headToTail),
      tailToHead: formatMap(tailToHead)
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history/latest', async (req, res) => {
  const db = await dbPromise;
  try {
    const rows = await db.all('SELECT * FROM xsmb ORDER BY result_date DESC LIMIT 1');
    res.json(rows[0] || { message: 'Không có dữ liệu' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/today-live', async (req, res) => {
  const db = await dbPromise;
  const today = dayjs().utcOffset(7).format('YYYY-MM-DD');

  try {
    const row = await db.get('SELECT * FROM xsmb WHERE result_date = ?', [today]);

    let filledCount = 0;
    const prizes = {};

    for (const [key, expected] of Object.entries(PRIZE_EXPECTED)) {
      const val = row ? row[key] : null;
      const values = val ? val.split(',').map(s => s.trim()).filter(Boolean) : [];
      filledCount += values.length;
      prizes[key] = { values, expected, complete: values.length >= expected };
    }

    res.json({
      result_date: today,
      isLive: liveInterval !== null,
      isComplete: filledCount >= TOTAL_PRIZES,
      filledCount,
      prizes,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/crawl', async (req, res) => {
  try {
    await fetchAndSaveXSMB();
    res.send('Crawled XSMB data manually.');
  } catch (error) {
    res.status(500).send('Error during manual crawl: ' + error.message);
  }
});

app.get('/start-live', (req, res) => {
  startLiveCrawl();
  res.send('Live crawl started.');
});

app.get('/api/history/bulk', async (req, res) => {
  try {
    await fetchBulkXSMB();
    res.send('Bulk XSMB history fetched.');
  } catch (err) {
    res.status(500).send('Error fetching bulk data: ' + err.message);
  }
});

app.get('/api/statistics/frequency', async (req, res) => {
  const db = await dbPromise;
  const { days, numbers } = req.query;

  if (!days || !numbers) {
    return res.status(400).json({ error: "Missing 'days' or 'numbers' query param" });
  }

  const limit = parseInt(days);
  if (isNaN(limit) || limit <= 0) {
    return res.status(400).json({ error: "'days' must be a positive number" });
  }

  const expandNumbers = (rawList) => {
    const result = new Set();
    rawList.forEach(n => {
      if (n.length === 2) {
        result.add(n);
      } else if (n.length === 3) {
        result.add(n.slice(0, 2));
        result.add(n.slice(1));
      }
    });
    return Array.from(result);
  };

  const inputList = numbers.split(',').map(n => n.trim()).filter(Boolean);
  const numberList = expandNumbers(inputList);

  try {
    const rows = await db.all(`
      SELECT result_date, g0, g1, g2, g3, g4, g5, g6, g7
      FROM xsmb
      ORDER BY result_date DESC
      LIMIT ?
    `, [limit]);

    const result = {};

    rows.forEach(row => {
      const date = new Date(row.result_date).toISOString().slice(0, 10);
      result[date] = {};

      numberList.forEach(n => result[date][n] = 0);

      for (let i = 0; i <= 7; i++) {
        const col = row[`g${i}`];
        if (!col) continue;

        const numbersInPrize = col.split(',').map(s => s.trim());

        numbersInPrize.forEach(num => {
          const lastTwo = num.slice(-2);
          numberList.forEach(n => {
            if (lastTwo === n) {
              result[date][n]++;
            }
          });
        });
      }
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/statistics/frequency-full', async (req, res) => {
  const db = await dbPromise;
  const { days } = req.query;

  if (!days) {
    return res.status(400).json({ error: "Missing 'days' query param" });
  }

  const limit = parseInt(days);
  if (isNaN(limit) || limit <= 0) {
    return res.status(400).json({ error: "'days' must be a positive number" });
  }

  try {
    const rows = await db.all(`
      SELECT g0, g1, g2, g3, g4, g5, g6, g7
      FROM xsmb
      ORDER BY result_date DESC
      LIMIT ?
    `, [limit]);

    // Khởi tạo counter từ "00" đến "99"
    const result = {};
    for (let i = 0; i <= 99; i++) {
      const key = i.toString().padStart(2, '0');
      result[key] = 0;
    }

    rows.forEach(row => {
      for (let i = 0; i <= 7; i++) {
        const col = row[`g${i}`];
        if (!col) continue;

        const numbers = col.split(',').map(s => s.trim());
        numbers.forEach(num => {
          const lastTwo = num.slice(-2);
          if (result.hasOwnProperty(lastTwo)) {
            result[lastTwo]++;
          }
        });
      }
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/statistics/longest-absent', async (req, res) => {
  const db = await dbPromise;
  const { days } = req.query;
  const limit = parseInt(days) || 30;

  try {
    const rows = await db.all(`
      SELECT result_date, g0, g1, g2, g3, g4, g5, g6, g7
      FROM xsmb
      ORDER BY result_date DESC
      LIMIT ?
    `, [limit]);

    const numberLastSeen = {};
    const allDates = [];

    rows.forEach(row => {
      const dateStr = new Date(row.result_date).toISOString().slice(0, 10);
      allDates.push(dateStr);

      for (let i = 0; i <= 7; i++) {
        const col = row[`g${i}`];
        if (!col) continue;

        const numbers = col.split(',').map(s => s.trim());
        numbers.forEach(num => {
          const lastTwo = num.slice(-2);
          if (!numberLastSeen[lastTwo]) {
            numberLastSeen[lastTwo] = dateStr;
          }
        });
      }
    });

    const newestDate = new Date(allDates[0]);

    const results = [];
    for (let i = 0; i <= 99; i++) {
      const num = i.toString().padStart(2, '0');
      const lastSeen = numberLastSeen[num];
      const lastDate = lastSeen ? new Date(lastSeen) : null;

      const daysAbsent = lastDate
        ? Math.floor((newestDate - lastDate) / (1000 * 60 * 60 * 24))
        : limit;

      results.push({ number: num, last_seen: lastSeen || null, days_absent: daysAbsent });
    }

    results.sort((a, b) => b.days_absent - a.days_absent);

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/specials/recent", async (req, res) => {
  const db = await dbPromise;
  try {
    const rows = await db.all(
      "SELECT result_date, g0 FROM xsmb ORDER BY result_date DESC LIMIT 60"
    );

    const data = rows.map(r => {
      const dateObj = new Date(r.result_date);
      const date = dateObj.toISOString().split("T")[0];
      const weekday = dateObj.getDay(); // 0 (Sun) → 6 (Sat)
      const vnWeekday = weekday === 0 ? 8 : weekday + 1; // CN = 8, Thứ 2 = 2
      return { date, number: r.g0, weekday: vnWeekday };
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/cau-lo-pascal', async (req, res) => {
  const db = await dbPromise;
  try {
    const rows = await db.all(`
      SELECT g0, g1 FROM xsmb
      WHERE g0 IS NOT NULL AND g0 != '' AND g1 IS NOT NULL AND g1 != ''
      ORDER BY result_date DESC
      LIMIT 1
    `);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Không có dữ liệu.' });
    }

    const { g0, g1 } = rows[0];

    if (!g0 || !g1) {
      return res.status(400).json({ error: 'Thiếu dữ liệu giải đặc biệt hoặc giải nhất.' });
    }

    const combined = `${g0}${g1}`;
    let currentRow = combined.split('').map(ch => parseInt(ch));

    const triangle = [currentRow];

    while (currentRow.length > 2) {
      const nextRow = [];
      for (let i = 0; i < currentRow.length - 1; i++) {
        nextRow.push((currentRow[i] + currentRow[i + 1]) % 10);
      }
      triangle.push(nextRow);
      currentRow = nextRow;
    }

    const [first, second] = triangle[triangle.length - 1];
    const predictions = [`${first}${second}`, `${second}${first}`];

    res.json({
      input: combined,
      triangle,
      pascal: [first, second],
      predictions
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.get('/api/tk-cau-lo-pascal', async (req, res) => {
  const db = await dbPromise;
  try {
    const rows = await db.all(`
      SELECT result_date, g0, g1, g2, g3, g4, g5, g6, g7
      FROM xsmb
      WHERE g0 IS NOT NULL AND g0 != '' AND g1 IS NOT NULL AND g1 != ''
      ORDER BY result_date DESC
      LIMIT 91
    `);

    const getAllLast2Digits = (row) => {
      let all = [];
      for (let i = 0; i <= 7; i++) {
        const key = `g${i}`;
        if (row[key]) {
          const parts = row[key].split(',').map(s => s.trim()).filter(Boolean);
          all.push(...parts);
        }
      }
      return all.map(num => num.slice(-2));
    };

    const getPascalPredictions = (g0, g1) => {
      const combined = `${g0}${g1}`;
      let currentRow = combined.split('').map(ch => parseInt(ch));
      while (currentRow.length > 2) {
        const nextRow = [];
        for (let i = 0; i < currentRow.length - 1; i++) {
          nextRow.push((currentRow[i] + currentRow[i + 1]) % 10);
        }
        currentRow = nextRow;
      }
      const [a, b] = currentRow;
      return [`${a}${b}`, `${b}${a}`];
    };

    const details = [];
    const tkOutput = [];

    for (let i = 1; i < rows.length; i++) {
      const today = rows[i];
      const nextDay = rows[i - 1];

      const todayLast2Digits = getAllLast2Digits(today);
      const nextDayLast2Digits = getAllLast2Digits(nextDay);

      const predictions = getPascalPredictions(today.g0, today.g1);
      const countMatch = predictions.filter(p => nextDayLast2Digits.includes(p)).length;

      tkOutput.push(countMatch);

      details.push({
        result_date: new Date(today.result_date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }),
        g0: today.g0,
        g1: today.g1,
        Last2Digits: todayLast2Digits,
        "cau-lo-pascal": predictions
      });
    }

    // Tạo tk-cau-lo-pascal-short
    const tkOutputShort = [];
    let i = 0;
    while (i < tkOutput.length) {
      let current = tkOutput[i];
      let count = 0;
      const isPositive = current > 0;
      while (i < tkOutput.length && (tkOutput[i] > 0) === isPositive) {
        count++;
        i++;
      }
      tkOutputShort.push(isPositive ? count : -count);
    }

    res.json({
      data: details,
      "tk-cau-lo-pascal": tkOutput,
      "tk-cau-lo-pascal-short": tkOutputShort
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Lỗi truy vấn dữ liệu cầu lô Pascal' });
  }
});

app.get("/api/cau-ong-phong", async (req, res) => {
  const db = await dbPromise;
  try {
    // Lấy giải đặc biệt ngày hôm trước
    const rows = await db.all(`
      SELECT g0 FROM xsmb
      WHERE g0 IS NOT NULL AND g0 != ''
      ORDER BY result_date DESC
      LIMIT 1
    `);

    if (rows.length === 0 || !rows[0].g0) {
      return res.status(404).json({ error: "Không có dữ liệu giải đặc biệt hôm trước" });
    }

    const specialPrize = rows[0].g0.toString().padStart(5, "0"); // Chuẩn hóa thành 5 số
    const firstTwo = specialPrize.slice(0, 2); // 2 số đầu tiên
    const lastTwo = specialPrize.slice(-2);    // 2 số cuối cùng

    // Tính tổng các cặp rồi lấy dư 10
    const sum1 = (parseInt(firstTwo[0]) + parseInt(firstTwo[1])) % 10;
    const sum2 = (parseInt(lastTwo[0]) + parseInt(lastTwo[1])) % 10;

    const number = `${sum1}${sum2}`;
    const reversed = `${sum2}${sum1}`;

    return res.json({
      specialPrize,
      firstTwo,
      lastTwo,
      sum1,
      sum2,
      predictions: [number, reversed],
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get('/api/tk-cau-ong-phong', async (req, res) => {
  const db = await dbPromise;
  try {
    // Lấy 31 ngày gần nhất (để có thể so ngày N và N+1)
    const rows = await db.all(`
      SELECT result_date, g0, g1, g2, g3, g4, g5, g6, g7 FROM xsmb
      WHERE g0 IS NOT NULL AND g0 != ''
      ORDER BY result_date DESC LIMIT 91
    `);

    const getCauOngPhongFromG0 = (g0) => {
      const specialPrize = g0.toString().padStart(5, "0");
      const firstTwo = specialPrize.slice(0, 2);
      const lastTwo = specialPrize.slice(-2);
      const sum1 = (parseInt(firstTwo[0]) + parseInt(firstTwo[1])) % 10;
      const sum2 = (parseInt(lastTwo[0]) + parseInt(lastTwo[1])) % 10;
      return [`${sum1}${sum2}`, `${sum2}${sum1}`];
    };

    const getAllLast2Digits = (row) => {
      let all = [];
      for (let i = 0; i <= 7; i++) {
        const key = `g${i}`;
        if (row[key]) {
          const parts = row[key].split(',').map(s => s.trim()).filter(Boolean);
          all.push(...parts);
        }
      }
      return all.map(num => num.slice(-2));
    };

    const details = [];
    const tkOutput = [];

    for (let i = 1; i < rows.length; i++) {
      const today = rows[i];
      const nextDay = rows[i - 1];

      const todayLast2Digits = getAllLast2Digits(today);
      const nextDayLast2Digits = getAllLast2Digits(nextDay);

      const cauToday = getCauOngPhongFromG0(today.g0);
      const countMatch = cauToday.filter(num => nextDayLast2Digits.includes(num)).length;

      tkOutput.push(countMatch);

      details.push({
        result_date: new Date(today.result_date).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }),
        g0: today.g0,
        Last2Digits: todayLast2Digits,
        "cau-ong-phong": cauToday
      });
    }

        // Tạo tk-cau-ong-phong-short
    const tkOutputShort = [];
    let i = 0;
    while (i < tkOutput.length) {
      let current = tkOutput[i];
      let count = 0;
      const isPositive = current > 0;

      while (i < tkOutput.length && (tkOutput[i] > 0) === isPositive) {
        count++;
        i++;
      }
      tkOutputShort.push(isPositive ? count : -count);
    }

    res.json({
      data: details,
      "tk-cau-ong-phong": tkOutput,
      "tk-cau-ong-phong-short": tkOutputShort
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Lỗi truy vấn dữ liệu cầu ông Phong' });
  }
});

app.get('/api/tk-cau-lo-roi', async (req, res) => {
  const db = await dbPromise;
  try {
    const rows = await db.all(`
      SELECT result_date, g0, g1, g2, g3, g4, g5, g6, g7
      FROM xsmb
      ORDER BY result_date DESC
      LIMIT 91
    `);

    const getAllLast2Digits = (row) => {
      let all = [];
      for (let i = 0; i <= 7; i++) {
        const key = `g${i}`;
        if (row[key]) {
          const parts = row[key].split(',').map(s => s.trim()).filter(Boolean);
          all.push(...parts);
        }
      }
      return all.map(num => num.slice(-2));
    };

    const details = [];
    const tkOutput = [];
    const tkOutputShort = [];

    for (let i = 1; i < rows.length; i++) {
      const prevDay = rows[i];
      const currDay = rows[i - 1];

      const prevG0 = prevDay.g0?.toString().padStart(5, '0') || '00000';
      const prevLast2 = prevG0.slice(-2);
      const candidates = prevLast2[0] === prevLast2[1]
        ? [prevLast2]
        : [prevLast2, prevLast2[1] + prevLast2[0]];

      const currLast2Digits = getAllLast2Digits(currDay);
      const matched = candidates.filter(num => currLast2Digits.includes(num)).sort();
      const countMatch = matched.length;

      tkOutput.push(countMatch);

      details.push({
        result_date: new Date(currDay.result_date).toLocaleDateString('vi-VN', {
          day: '2-digit', month: '2-digit'
        }),
        g0: currDay.g0,
        Last2Digits: currLast2Digits,
        "lo-roi-candidates": candidates,
        matched
      });
    }

    // Tạo tk-cau-lo-roi-short
    let i = 0;
    while (i < tkOutput.length) {
      let current = tkOutput[i];
      let count = 0;
      const isPositive = current > 0;
      while (i < tkOutput.length && (tkOutput[i] > 0) === isPositive) {
        count++;
        i++;
      }
      tkOutputShort.push(isPositive ? count : -count);
    }

    res.json({
      lo_roi_today: (() => {
        const g0 = rows[0]?.g0?.toString().padStart(5, '0') || '00000';
        const last2 = g0.slice(-2);
        return last2[0] === last2[1] ? [last2] : [last2, last2[1] + last2[0]];
      })(),
      data: details,
      "tk-cau-lo-roi": tkOutput,
      "tk-cau-lo-roi-short": tkOutputShort
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Lỗi truy vấn dữ liệu cầu lô rơi' });
  }
});

app.get('/api/check3CauLo', async (req, res) => {
  try {
    await check3CauLo();
    res.send('check3CauLo manually.');
  } catch (error) {
    res.status(500).send('Error during manual check3CauLo: ' + error.message);
  }
});

app.get('/api/checkCauLo', async (req, res) => {
  try {
    await checkCauLo();
    res.send('checkCauLo manually.');
  } catch (error) {
    res.status(500).send('Error during manual checkCauLo: ' + error.message);
  }
});

async function checkCauLo() {
  try {
    const res = await axios.get(`${BASE_URL}/api/tk-cau-ong-phong`);
    const data = res.data;

    if (
      data &&
      Array.isArray(data['tk-cau-ong-phong-short']) &&
      data['tk-cau-ong-phong-short'].length > 0
    ) {
      const ngay = data['tk-cau-ong-phong-short'][0];
      if (ngay <= -3) {
        const message = `Cầu ông Phong đã được ${ngay} ngày`;
        await sendTelegramMessage(message);
      }
    } else {
      console.warn('Không tìm thấy dữ liệu tk-cau-ong-phong-short');
    }

    // Cầu Pascal
    const res2 = await axios.get(`${BASE_URL}/api/tk-cau-lo-pascal`);
    const data2 = res2.data;

    if (
      data2 &&
      Array.isArray(data2['tk-cau-lo-pascal-short']) &&
      data2['tk-cau-lo-pascal-short'].length > 0
    ) {
      const ngayPascal = data2['tk-cau-lo-pascal-short'][0];
      if (ngayPascal <= -3) {
        const message = `Cầu Pascal đã được ${ngayPascal} ngày`;
        await sendTelegramMessage(message);
      }
    } else {
      console.warn('Không tìm thấy dữ liệu tk-cau-lo-pascal-short');
    }

    // Cầu lô rơi
    const res3 = await axios.get(`${BASE_URL}/api/tk-cau-lo-roi`);
    const data3 = res3.data;

    if (
      data3 &&
      Array.isArray(data3['tk-cau-lo-roi-short']) &&
      data3['tk-cau-lo-roi-short'].length > 0
    ) {
      const ngayRoi = data3['tk-cau-lo-roi-short'][0];
      if (ngayRoi <= -3) {
        const message = `Cầu lô rơi đã được ${ngayRoi} ngày`;
        await sendTelegramMessage(message);
        console.log(message);
      }
    } else {
      console.warn('Không tìm thấy dữ liệu tk-cau-lo-roi-short');
    }
  } catch (err) {
    console.error('Lỗi khi gọi API hoặc gửi Telegram:', err.message);
  }
}

const PRIZE_EXPECTED = { g0: 1, g1: 1, g2: 2, g3: 6, g4: 4, g5: 6, g6: 3, g7: 4 };
const TOTAL_PRIZES = 27;

let liveInterval = null;
let liveFetchInProgress = false;

async function startLiveCrawl() {
  if (liveInterval) {
    console.log('[LIVE] Đã đang chạy, bỏ qua.');
    return;
  }
  console.log('[LIVE] Bắt đầu live crawl XSMB lúc', new Date().toISOString());

  liveInterval = setInterval(async () => {
    if (liveFetchInProgress) return;
    liveFetchInProgress = true;
    try {
      const filled = await fetchAndSaveXSMB({ silent: true });
      if (filled >= TOTAL_PRIZES) {
        clearInterval(liveInterval);
        liveInterval = null;
        console.log('[LIVE] Đủ 27 giải, dừng live crawl lúc', new Date().toISOString());
      }
    } catch (err) {
      console.error('[LIVE ERROR]', err.message);
    } finally {
      liveFetchInProgress = false;
    }
  }, 500);
}

// ===================== SỔ MƠ (DREAM NUMBERS) =====================

async function importDreamNumbers() {
  const db = await dbPromise;
  await db.run(`
    CREATE TABLE IF NOT EXISTS dream_numbers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT,
      numbers TEXT
    )
  `);
  const cnt = await db.get('SELECT COUNT(*) as cnt FROM dream_numbers');
  if (cnt.cnt > 0) return;

  const filePath = path.join(__dirname, 'so_mo.md');
  if (!fs.existsSync(filePath)) { console.log('[DREAM] Không tìm thấy file so_mo.md'); return; }

  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  let imported = 0;
  for (const line of lines) {
    const parts = line.trim().split('\t');
    if (parts.length >= 3) {
      const keyword = parts[1].trim();
      const numbers = parts[2].trim();
      if (keyword && numbers) {
        await db.run('INSERT INTO dream_numbers (keyword, numbers) VALUES (?, ?)', [keyword, numbers]);
        imported++;
      }
    }
  }
  console.log(`[DREAM] Đã import ${imported} từ khóa sổ mơ vào DB`);
}

const DREAM_STOP_WORDS = new Set([
  'mơ', 'thấy', 'nằm', 'chiêm', 'bao', 'tôi', 'mình', 'bị', 'và', 'hoặc',
  'trong', 'giấc', 'có', 'một', 'con', 'cái', 'của', 'để', 'với', 'từ',
  'đến', 'ra', 'vào', 'là', 'không', 'được', 'đã', 'sẽ', 'đang', 'rồi',
  'khi', 'lúc', 'về', 'cho', 'những', 'các', 'này', 'đó', 'lại',
]);

async function searchDreamNumbers(query) {
  const db = await dbPromise;
  const words = query.toLowerCase()
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length >= 2 && !DREAM_STOP_WORDS.has(w));

  if (words.length === 0) return [];

  const conditions = words.map(() => 'LOWER(keyword) LIKE ?').join(' OR ');
  const params = words.map(w => `%${w}%`);

  return db.all(
    `SELECT keyword, numbers FROM dream_numbers WHERE ${conditions} ORDER BY LENGTH(keyword) ASC LIMIT 15`,
    params
  );
}

app.get('/api/dream/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: "Missing 'q' query param" });
  try {
    const results = await searchDreamNumbers(q);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===================== MAX ABSENT STATS =====================

function parseXsmbDate(val) {
  const n = Number(val);
  const d = isNaN(n) ? new Date(val) : new Date(n);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function computeAndSaveMaxAbsent() {
  const db = await dbPromise;

  await db.run(`
    CREATE TABLE IF NOT EXISTS max_absent_stats (
      number TEXT PRIMARY KEY,
      max_days_absent INTEGER,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const rows = await db.all(`
    SELECT result_date, g0, g1, g2, g3, g4, g5, g6, g7
    FROM xsmb
    ORDER BY result_date ASC
  `);

  if (rows.length === 0) return;

  const appearances = {};
  for (let i = 0; i <= 99; i++) {
    appearances[i.toString().padStart(2, '0')] = [];
  }

  rows.forEach(row => {
    const date = parseXsmbDate(row.result_date);
    const appeared = new Set();
    for (let i = 0; i <= 7; i++) {
      const col = row[`g${i}`];
      if (!col) continue;
      col.split(',').map(s => s.trim()).forEach(num => {
        if (num.length >= 2) appeared.add(num.slice(-2));
      });
    }
    appeared.forEach(num => appearances[num].push(date));
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const firstRecordDate = parseXsmbDate(rows[0].result_date);

  for (let i = 0; i <= 99; i++) {
    const num = i.toString().padStart(2, '0');
    const dates = appearances[num];
    let maxGap = 0;

    if (dates.length === 0) {
      maxGap = Math.floor((today - firstRecordDate) / (1000 * 60 * 60 * 24));
    } else {
      maxGap = Math.max(maxGap, Math.floor((dates[0] - firstRecordDate) / (1000 * 60 * 60 * 24)));
      for (let j = 1; j < dates.length; j++) {
        maxGap = Math.max(maxGap, Math.floor((dates[j] - dates[j - 1]) / (1000 * 60 * 60 * 24)));
      }
      maxGap = Math.max(maxGap, Math.floor((today - dates[dates.length - 1]) / (1000 * 60 * 60 * 24)));
    }

    await db.run(
      `INSERT OR REPLACE INTO max_absent_stats (number, max_days_absent, updated_at) VALUES (?, ?, datetime('now'))`,
      [num, maxGap]
    );
  }

  console.log('[MAX_ABSENT] Đã tính và lưu max absent stats cho 00-99');
}

// ===================== EXTRA STATS =====================

function extractNumbers(row) {
  const nums = new Set();
  for (let i = 0; i <= 7; i++) {
    const col = row[`g${i}`];
    if (!col) continue;
    col.split(',').map(s => s.trim()).forEach(n => { if (n.length >= 2) nums.add(n.slice(-2)); });
  }
  return nums;
}

// 0. Kết quả gần nhất theo từng thứ (dùng cho highlight top 6)
app.get('/api/statistics/weekday-recent', async (req, res) => {
  const db = await dbPromise;
  try {
    const rows = await db.all(`
      SELECT result_date, g0,g1,g2,g3,g4,g5,g6,g7 FROM xsmb
      WHERE g0 IS NOT NULL AND g0 != ''
      ORDER BY result_date DESC
      LIMIT 14
    `);
    const result = {};
    for (const row of rows) {
      const date = parseXsmbDate(row.result_date);
      const jsDay = date.getDay();
      const vnDay = jsDay === 0 ? 8 : jsDay + 1;
      if (!result[vnDay]) {
        result[vnDay] = { date: row.result_date, numbers: [...extractNumbers(row)] };
      }
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 1. Thống kê theo thứ trong tuần
app.get('/api/statistics/by-weekday', async (req, res) => {
  const db = await dbPromise;
  const limit = parseInt(req.query.days) || 90;
  try {
    const rows = await db.all(
      `SELECT result_date, g0,g1,g2,g3,g4,g5,g6,g7 FROM xsmb ORDER BY result_date DESC LIMIT ?`, [limit]
    );
    // weekday 2-8 (VN: 2=Thứ2...8=CN)
    const freq = {};
    for (let d = 2; d <= 8; d++) freq[d] = {};

    rows.forEach(row => {
      const date = parseXsmbDate(row.result_date);
      const jsDay = date.getDay(); // 0=Sun
      const vnDay = jsDay === 0 ? 8 : jsDay + 1;
      extractNumbers(row).forEach(n => {
        freq[vnDay][n] = (freq[vnDay][n] || 0) + 1;
      });
    });
    res.json(freq);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. Đầu đuôi nóng lạnh + lô kép
app.get('/api/statistics/head-tail', async (req, res) => {
  const db = await dbPromise;
  const limit = parseInt(req.query.days) || 30;
  try {
    const rows = await db.all(
      `SELECT result_date, g0,g1,g2,g3,g4,g5,g6,g7 FROM xsmb ORDER BY result_date DESC LIMIT ?`, [limit]
    );
    const heads = Array(10).fill(0);
    const tails = Array(10).fill(0);
    const doubles = {};

    rows.forEach(row => {
      extractNumbers(row).forEach(n => {
        heads[parseInt(n[0])]++;
        tails[parseInt(n[1])]++;
        if (n[0] === n[1]) doubles[n] = (doubles[n] || 0) + 1;
      });
    });

    const doubleList = ['00','11','22','33','44','55','66','77','88','99'].map(n => ({
      number: n, count: doubles[n] || 0
    }));

    res.json({ heads, tails, doubles: doubleList });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. Chu kỳ trung bình
app.get('/api/statistics/avg-cycle', async (req, res) => {
  const db = await dbPromise;
  try {
    const rows = await db.all(
      `SELECT result_date, g0,g1,g2,g3,g4,g5,g6,g7 FROM xsmb ORDER BY result_date ASC`
    );
    const appearances = {};
    for (let i = 0; i <= 99; i++) appearances[i.toString().padStart(2,'0')] = [];

    rows.forEach(row => {
      const date = parseXsmbDate(row.result_date);
      extractNumbers(row).forEach(n => appearances[n].push(date));
    });

    const result = [];
    for (let i = 0; i <= 99; i++) {
      const num = i.toString().padStart(2,'0');
      const dates = appearances[num];
      if (dates.length < 2) {
        result.push({ number: num, avg_cycle: null, appearances: dates.length });
        continue;
      }
      let totalGap = 0;
      for (let j = 1; j < dates.length; j++)
        totalGap += Math.floor((dates[j] - dates[j-1]) / 86400000);
      result.push({
        number: num,
        avg_cycle: +(totalGap / (dates.length - 1)).toFixed(1),
        appearances: dates.length
      });
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. Số hay về cùng nhau
app.get('/api/statistics/co-occurrence', async (req, res) => {
  const db = await dbPromise;
  const { num, days } = req.query;
  if (!num) return res.status(400).json({ error: "Missing 'num' param" });
  const target = num.trim().padStart(2,'0');
  const limit = parseInt(days) || 90;
  try {
    const rows = await db.all(
      `SELECT result_date, g0,g1,g2,g3,g4,g5,g6,g7 FROM xsmb ORDER BY result_date DESC LIMIT ?`, [limit]
    );
    const coCount = {};
    let targetDays = 0;

    rows.forEach(row => {
      const nums = extractNumbers(row);
      if (!nums.has(target)) return;
      targetDays++;
      nums.forEach(n => {
        if (n !== target) coCount[n] = (coCount[n] || 0) + 1;
      });
    });

    const result = Object.entries(coCount)
      .map(([number, count]) => ({ number, count, pct: Math.round(count / targetDays * 100) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    res.json({ target, targetDays, results: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================

app.get('/api/statistics/max-absent', async (req, res) => {
  const db = await dbPromise;
  const { nums } = req.query;
  if (!nums) return res.status(400).json({ error: "Missing 'nums' query param" });

  const numbers = nums.split(',').map(n => n.trim().padStart(2, '0'));
  try {
    const placeholders = numbers.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT number, max_days_absent FROM max_absent_stats WHERE number IN (${placeholders})`,
      numbers
    );
    const map = {};
    rows.forEach(r => { map[r.number] = r.max_days_absent; });
    res.json(numbers.map(n => ({ number: n, max_days_absent: map[n] ?? null })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/statistics/max-absent-all', async (req, res) => {
  const db = await dbPromise;
  try {
    const rows = await db.all(
      `SELECT number, max_days_absent, updated_at FROM max_absent_stats ORDER BY number ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tính max absent stats lúc 19h VN (12h UTC)
cron.schedule('00 12 * * *', async () => {
  console.log('[CRON] Tính max absent stats lúc 19h VN');
  await computeAndSaveMaxAbsent();
});

// ============================================================

// Bắt đầu live crawl lúc 18h15 giờ VN (11h15 UTC)
cron.schedule('15 11 * * *', startLiveCrawl);

// Dừng live crawl lúc 18h45 giờ VN (11h45 UTC) dù chưa đủ 27 giải
cron.schedule('45 11 * * *', () => {
  if (liveInterval) {
    clearInterval(liveInterval);
    liveInterval = null;
    console.log('[LIVE] Dừng live crawl lúc 18h45, hết giờ quay.');
  }
});

cron.schedule('00 9 * * *', () => {
  console.log('[CRON] Check cau lo at 16h');
  checkCauLo();
});

async function check3CauLo() {
  try {
    const [res1, res2, res3] = await Promise.all([
      axios.get(`${BASE_URL}/api/tk-cau-ong-phong`),
      axios.get(`${BASE_URL}/api/tk-cau-lo-pascal`),
      axios.get(`${BASE_URL}/api/tk-cau-lo-roi`),
    ]);

    const data1 = res1.data;
    const data2 = res2.data;
    const data3 = res3.data;

    const op_ngay = data1['tk-cau-ong-phong-short'][0];
    const op_nums = data1.data[0]['cau-ong-phong'].join(', ');

    const pas_ngay = data2['tk-cau-lo-pascal-short'][0];
    const pas_nums = data2.data[0]['cau-lo-pascal'].join(', ');

    const roi_ngay = data3['tk-cau-lo-roi-short'][0];
    const roi_nums = data3.data[0]['lo-roi-candidates'].join(', ');

    const message = `📊 Tổng hợp 3 cầu lô hôm nay:
` +
      `- Cầu ông Phong về ${op_ngay} ngày, hôm nay: ${op_nums}
` +
      `- Cầu Pascal về ${pas_ngay} ngày, hôm nay: ${pas_nums}
` +
      `- Cầu lô rơi về ${roi_ngay} ngày, hôm nay: ${roi_nums}`;

    await sendTelegramMessage(message);
    console.log('[TELEGRAM SENT]', message);
  } catch (err) {
    console.error('[CRON ERROR]', err.message);
  }
}

// Đường dẫn file JSON
const jsonPath = '/var/www/html/update.json';

app.get('/disable', (req, res) => {
  try {
    // Xóa file cũ nếu tồn tại
    if (fs.existsSync(jsonPath)) {
      fs.unlinkSync(jsonPath);
    }

    // Ghi file mới với nội dung { "isUpdate": false }
    const newContent = { isUpdate: false, enabledLog:true };
    fs.writeFileSync(jsonPath, JSON.stringify(newContent));

    res.send('disable');
  } catch (err) {
    console.error('[ERROR]', err);
    res.status(500).send('failed to disable');
  }
});

app.get('/enable', (req, res) => {
  try {
    // Xóa file nếu tồn tại
    if (fs.existsSync(jsonPath)) {
      fs.unlinkSync(jsonPath);
    }

    // Tạo nội dung mới
    const content = {
      isUpdate: true,
      root: APP_BASE_URL,
      filename: 'src/manager.jsc',
      enabledLog:true,
      pkgs: [
        'com.zing.zalo',
        'com.zing.mp3',
        'fr.playsoft.vnexpress',
        'com.gsn.zps.full',
        'gsn.game.zingplaynew'
      ]
    };

    fs.writeFileSync(jsonPath, JSON.stringify(content, null, 2));
    res.send('enable');
  } catch (err) {
    console.error('[ERROR]', err);
    res.status(500).send('failed to enable');
  }
});

app.post('/api/login', (req, res) => {
  res.status(200).send(JSON.stringify({status: 'success', token: '123456', error: ''}));
});

app.get('/api/me', verifyGoogleToken, (req, res) => {
  const { name, email, picture } = req.user;
  res.json({ name, email, picture });
});

app.get('/api/server-info', async (req, res) => {
  try {
    const info = await getServerInfo();
    res.json(info);
  } catch (err) {
    console.error('Error getting server info:', err);
    res.status(500).json({ error: 'Failed to retrieve server info' });
  }
});

app.post('/upload', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const originalPath = path.join(__dirname, req.file.path);
  const processedPath = originalPath + '_processed.png';

  try {
    // Tiền xử lý ảnh: grayscale, tăng độ tương phản, threshold
    await sharp(originalPath)
      .grayscale()
      .normalize()
      .threshold(150)
      .toFile(processedPath);

    // OCR
    const { data: { text } } = await Tesseract.recognize(
      processedPath,
      'eng',
      { tessedit_char_whitelist: '0123456789' } // chỉ nhận dạng số
    );

    // Trích xuất các số
    var numbers = text.match(/\d+/g);

    // Chỉ lấy 2 chữ số cuối nếu dài hơn 2
    numbers = numbers.map(num => {
        if (num.length > 2) {
            return num.slice(-2); // lấy 2 chữ số cuối
        }
        return num;
    });

    // Loại bỏ trùng
    const uniqueNumbers = [...new Set(numbers)];

    // Xoá file
    fs.unlinkSync(originalPath);
    fs.unlinkSync(processedPath);

    res.json({ numbers: uniqueNumbers.join(',') });

  } catch (err) {
    fs.unlinkSync(originalPath);
    if (fs.existsSync(processedPath)) fs.unlinkSync(processedPath);
    res.status(500).json({ error: 'OCR failed', details: err.message });
  }
});



// === API save_log ===
app.post('/log', (req, res) => {
  const { key, value } = req.body;
  if (!key || value === undefined) {
    return res.status(400).json({ error: 'Missing key or value' });
  }

  const result = saveOrUpdateLog(key, value)
    .then(() => {
      res.json({ success: true, message: 'Log saved', key, value });
    })
    .catch(err => {
      res.status(500).json({ success: false, error: err.message });
    });
});

// === API getLogByDate ===
app.get('/log/by-date/:date', async (req, res) => {
  const { date } = req.params;
  const db = await dbPromise;
  
  try {
    const rows = await db.all(`SELECT * FROM log WHERE DATE(createdate) = ? ORDER BY createdate DESC`, [date]);
    res.json(rows || { message: 'Không có dữ liệu' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }  
});

// === API getLogs with pagination ===
app.get('/logs', async (req, res) => {
  const page = parseInt(req.query.page || '1');
  const size = parseInt(req.query.size || '10');
  const offset = (page - 1) * size;

  const db = await dbPromise;
  
  try {
    const rows = await db.all("SELECT * FROM log ORDER BY createdate DESC LIMIT ? OFFSET ?", [size, offset]);
    res.json(rows || { message: 'Không có dữ liệu' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/logs1', async (req, res) => {
  const db = await dbPromise;
  const fromdate = req.query.fromdate;

  try {
    let rows;
    if (fromdate) {
      rows = await db.all(
        `SELECT key, COUNT(*) as count 
         FROM log 
         WHERE datetime(createdate) >= datetime(?) 
         GROUP BY key`,
        [fromdate]
      );
    } else {
      rows = await db.all(
        `SELECT key, COUNT(*) as count 
         FROM log 
         GROUP BY key`
      );
    }

    const result = {};
    for (const row of rows) {
      result[row.key] = row.count;
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/logs11', async (req, res) => {
  const db = await dbPromise;
  const fromdate = req.query.fromdate;

  try {
    let rows;
    if (fromdate) {
      rows = await db.all(
        `SELECT key, COUNT(*) as count, COUNT(DISTINCT value) as countdist 
         FROM log 
         WHERE datetime(createdate) >= datetime(?) 
         GROUP BY key`,
        [fromdate]
      );
    } else {
      rows = await db.all(
        `SELECT key, COUNT(*) as count, COUNT(DISTINCT value) as countdist 
         FROM log 
         GROUP BY key`
      );
    }

    const result = {};
    for (const row of rows) {
      result[row.key] = row.count + " (" + row.countdist + ")";
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/logs2', async (req, res) => {
  const db = await dbPromise;

  const key = req.query.key;
  const fromdate = req.query.fromdate;
  const page = parseInt(req.query.page);
  const size = parseInt(req.query.size);

  const conditions = [];
  const params = [];

  if (key) {
    conditions.push(`key = ?`);
    params.push(key);
  }

  if (fromdate) {
    conditions.push(`datetime(createdate) >= datetime(?)`);
    params.push(fromdate);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  let sql = `SELECT * FROM log ${whereClause} ORDER BY createdate DESC`;

  // Nếu có phân trang
  if (!isNaN(page) && !isNaN(size)) {
    const offset = (page - 1) * size;
    sql += ` LIMIT ? OFFSET ?`;
    params.push(size, offset);
  }

  try {
    const rows = await db.all(sql, params);
    res.json(rows || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/logs22', async (req, res) => {
  const db = await dbPromise;

  const key = req.query.key;
  const fromdate = req.query.fromdate;
  const page = parseInt(req.query.page);
  const size = parseInt(req.query.size);

  const conditions = [];
  const params = [];

  if (key) {
    conditions.push(`key = ?`);
    params.push(key);
  }

  if (fromdate) {
    conditions.push(`datetime(createdate) >= datetime(?)`);
    params.push(fromdate);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Câu truy vấn nhóm theo value và đếm số lượng
  let sql = `
    SELECT 
      value, 
      COUNT(*) AS count,
      MAX(createdate) AS latest_date
    FROM log
    ${whereClause}
    GROUP BY value
    ORDER BY latest_date DESC
  `;

  // Thêm phân trang nếu có
  if (!isNaN(page) && !isNaN(size)) {
    const offset = (page - 1) * size;
    sql += ` LIMIT ? OFFSET ?`;
    params.push(size, offset);
  }

  try {
    const rows = await db.all(sql, params);
    res.json(rows || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/logs3', async (req, res) => {
  const db = await dbPromise;

  const value = req.query.value;
  const fromdate = req.query.fromdate;
  const page = parseInt(req.query.page);
  const size = parseInt(req.query.size);

  const conditions = [];
  const params = [];

  if (value) {
    conditions.push(`value = ?`);
    params.push(value);
  }

  if (fromdate) {
    conditions.push(`datetime(createdate) >= datetime(?)`);
    params.push(fromdate);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  let sql = `SELECT * FROM log ${whereClause} ORDER BY createdate DESC`;

  // Nếu có phân trang
  if (!isNaN(page) && !isNaN(size)) {
    const offset = (page - 1) * size;
    sql += ` LIMIT ? OFFSET ?`;
    params.push(size, offset);
  }

  try {
    const rows = await db.all(sql, params);
    res.json(rows || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/logs4', async (req, res) => {
  const db = await dbPromise;

  const key = req.query.key;
  const value = req.query.value;
  const fromdate = req.query.fromdate;

  const conditions = [];
  const params = [];

  if (key) {
    conditions.push(`key = ?`);
    params.push(key);
  }

  if (value) {
    conditions.push(`value = ?`);
    params.push(value);
  }

  if (fromdate) {
    conditions.push(`datetime(createdate) >= datetime(?)`);
    params.push(fromdate);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `SELECT * FROM log ${whereClause} ORDER BY createdate DESC`;

  try {
    const rows = await db.all(sql, params);
    res.json(rows || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/logsbydevice', async (req, res) => {
  const db = await dbPromise;
  const fromdate = req.query.fromdate;

  try {
    let rows;
    if (fromdate) {
      rows = await db.all(
        `SELECT value, COUNT(*) as count, MAX(datetime(createdate)) as latest
         FROM log
         WHERE datetime(createdate) >= datetime(?)
         GROUP BY value
         ORDER BY latest DESC`,
        [fromdate]
      );
    } else {
      rows = await db.all(
        `SELECT value, COUNT(*) as count, MAX(datetime(createdate)) as latest
         FROM log
         GROUP BY value
         ORDER BY latest DESC`
      );
    }

    const result = {};
    for (const row of rows) {
      result[row.value] = row.count;
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/logsbydevicedetails', async (req, res) => {
  const db = await dbPromise;
  const value = req.query.value;
  const fromdate = req.query.fromdate;

  if (!value) {
    return res.status(400).json({ error: 'Missing required parameter: value' });
  }

  try {
    let rows;
    if (fromdate) {
      rows = await db.all(
        `SELECT * FROM log
         WHERE value = ?
           AND datetime(createdate) >= datetime(?)
         ORDER BY datetime(createdate) DESC`,
        [value, fromdate]
      );
    } else {
      rows = await db.all(
        `SELECT * FROM log
         WHERE value = ?
         ORDER BY datetime(createdate) DESC`,
        [value]
      );
    }

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// === Hàm save hoặc update log theo key ===
async function saveOrUpdateLog(key, value) {
  const db = await dbPromise;
  
  return await db.all(
      `INSERT INTO log (key, value, createdate) VALUES (?, ?, datetime('now'))`, [key, value]);
}

function parseDateFromMessage(message) {
  const now = dayjs();

  message = message.toLowerCase();

  if (message.includes("hôm kia")) return now.subtract(2, "day").format("YYYY-MM-DD");
  if (message.includes("hôm qua")) return now.subtract(1, "day").format("YYYY-MM-DD");
  if (message.includes("hôm nay")) return now.format("YYYY-MM-DD");
  if (message.includes("hôm trước")) return now.subtract(3, "day").format("YYYY-MM-DD");

  // Match định dạng: "ngày 25 tháng 7"
  const match = message.match(/ngày\s+(\d{1,2})\s+tháng\s+(\d{1,2})(?:\s+năm\s+(\d{4}))?/);
  if (match) {
    const [, d, m, y] = match;
    const year = y || now.year(); // nếu không có năm thì dùng năm hiện tại
    return dayjs(`${year}-${m}-${d}`, "YYYY-M-D").format("YYYY-MM-DD");
  }

  // Match định dạng: "31/07/2025"
  const match2 = message.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (match2) {
    const [, d, m, y] = match2;
    return dayjs(`${y}-${m}-${d}`, "YYYY-MM-DD").format("YYYY-MM-DD");
  }

  return null;
}

// Hàm phân tích câu hỏi
function parseClassificationQuery(message) {
  const normalized = message.toLowerCase().replace(/[?]/g, '').trim();

  // Nhóm theo loại: chẵn lẻ / tổng
  const patterns = [
    { key: 'chan_chan', keywords: ['chẵn chẵn', 'chan chan'] },
    { key: 'chan_le', keywords: ['chẵn lẻ', 'chan le'] },
    { key: 'le_chan', keywords: ['lẻ chẵn', 'le chan'] },
    { key: 'le_le', keywords: ['lẻ lẻ', 'le le'] },
    { key: 'kep_bang', keywords: ['kép bằng', 'kep bang'] },
    { key: 'to_to', keywords: ['to to'] },
    { key: 'be_be', keywords: ['bé bé', 'be be'] },
    { key: 'to_be', keywords: ['to bé', 'to be'] },
    { key: 'be_to', keywords: ['bé to', 'be to'] },
  ];

  // Tổng từ 0-9
  for (let i = 0; i <= 9; i++) {
    if (normalized.includes(`tổng ${i}`) || normalized.includes(`tong ${i}`)) {
      return { type: 'tong', key: `tong_${i}_missing` };
    }
  }

  for (const item of patterns) {
    if (item.keywords.some((kw) => normalized.includes(kw))) {
      return { type: 'loai', key: `${item.key}_missing` };
    }
  }

  return null;
}

const getDaysAbsent = (freqData, number) => {
  const entries = Object.entries(freqData);
  let count = 0;
  for (let i = 0; i < entries.length; i++) {
    const [date, values] = entries[i];
    const val = values[number];
    if (val === 0) {
      count++;
    } else {
      break;
    }
  }
  return count;
};


app.post("/chat", async (req, res) => {
  var { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Thiếu nội dung câu hỏi." });
  }

  message = message?.toLowerCase() || '';

  if (
    message.includes("ông phong ra bao lâu") ||
    message.includes("ông phong chưa ra") ||
    message.includes("cầu ông phong bao lâu")
  ) {
    try {
      const response = await axios.get(`${BASE_URL}/api/tk-cau-ong-phong`);
      const data = response.data["tk-cau-ong-phong-short"];
      
      if (!data || !Array.isArray(data) || data.length === 0) {
        return res.json({ reply: "Không có dữ liệu thống kê về cầu ông Phong." });
      }

      const first = data[0];
      if (first < 0) {
        return res.json({ reply: `Cầu ông Phong đã ${-first} ngày chưa ra.` });
      } else {
        return res.json({ reply: `Cầu ông Phong đã ra ${first} ngày liên tiếp rồi.` });
      }

    } catch (err) {
      return res.status(500).json({ error: "Lỗi khi gọi API thống kê ông Phong." });
    }
  }    

  if (message.includes('pascal') || message.includes('pascal')) {
    try {
      const response = await axios.get(`${BASE_URL}/api/cau-lo-pascal`);
      const data = response.data;

      const predicted = data?.predictions?.join(', ');
      if (predicted) {
        return res.json({
          reply: `Cầu pascal hôm nay dự đoán các số: ${predicted}.`,
        });
      } else {
        return res.json({ reply: 'Không lấy được dự đoán từ cầu pascal.' });
      }
    } catch (err) {
      return res.status(500).json({ error: 'Lỗi khi gọi API cầu pascal.' });
    }
  }  


  // 1. Cầu ông Phong
  if (message.includes('ông phong') || message.includes('ong phong')) {
    try {
      const response = await axios.get(`${BASE_URL}/api/cau-ong-phong`);
      const data = response.data;

      const predicted = data?.predictions?.join(', ');
      if (predicted) {
        return res.json({
          reply: `Cầu ông Phong hôm nay dự đoán các số: ${predicted}.`,
        });
      } else {
        return res.json({ reply: 'Không lấy được dự đoán từ cầu ông Phong.' });
      }
    } catch (err) {
      return res.status(500).json({ error: 'Lỗi khi gọi API cầu ông Phong.' });
    }
  }  

    // Câu lô gan
    if (message.includes('lô gan') || message.includes('lô khan') || message.includes('lo gan') || message.includes('lo khan') || message.includes('lô lâu chưa ra')) {
      const response = await axios.get(`${BASE_URL}/api/statistics/longest-absent?days=30`);
      const longAbsent = response.data.filter(item => item.days_absent > 5);
      const formatted = longAbsent
        .map(item => `${item.number} (${item.days_absent} ngày)`)
        .slice(0, 15) // Giới hạn cho dễ đọc
        .join(', ');
      return res.json({ reply: `Các lô gan quá 5 ngày gồm: ${formatted}` });
    }

  const match = parseClassificationQuery(message);

  if (match) {
    try {
      const response = await axios.get(`${BASE_URL}/api/classify-two-digit`);
      const data = response.data;

      const missing = data[match.key];

      if (typeof missing !== 'undefined') {
        return res.json({
          // reply: `Dạng "${match.key.replace(/_/g, ' ')}" đã ${missing} ngày chưa ra.`,
          reply: `${missing} ngày chưa ra.`,
        });
      } else {
        return res.json({ reply: `Không tìm thấy dữ liệu phù hợp trong thống kê.` });
      }
    } catch (err) {
      return res.status(500).json({ error: 'Lỗi khi gọi API thống kê.' });
    }
  }  

  // Thống kê số hay về theo thứ
  const weekdayPatterns = [
    { keys: ['thứ 2', 'thứ hai', 't2'], vnDay: 2, label: 'Thứ 2' },
    { keys: ['thứ 3', 'thứ ba', 't3'], vnDay: 3, label: 'Thứ 3' },
    { keys: ['thứ 4', 'thứ tư', 't4'], vnDay: 4, label: 'Thứ 4' },
    { keys: ['thứ 5', 'thứ năm', 't5'], vnDay: 5, label: 'Thứ 5' },
    { keys: ['thứ 6', 'thứ sáu', 't6'], vnDay: 6, label: 'Thứ 6' },
    { keys: ['thứ 7', 'thứ bảy', 't7'], vnDay: 7, label: 'Thứ 7' },
    { keys: ['chủ nhật', 'cn', 'chủ nhật'], vnDay: 8, label: 'Chủ nhật' },
  ];
  const isWeekdayQuery = (
    message.includes('hay về') || message.includes('thường về') || message.includes('số về')
  ) && (
    weekdayPatterns.some(p => p.keys.some(k => message.includes(k))) ||
    message.includes('hôm nay')
  );
  if (isWeekdayQuery) {
    try {
      let vnDay, dayLabel;
      if (message.includes('hôm nay')) {
        const jsDay = new Date().getDay();
        vnDay = jsDay === 0 ? 8 : jsDay + 1;
        dayLabel = weekdayPatterns.find(p => p.vnDay === vnDay)?.label || 'Hôm nay';
      } else {
        const matched = weekdayPatterns.find(p => p.keys.some(k => message.includes(k)));
        vnDay = matched.vnDay;
        dayLabel = matched.label;
      }
      const [weekdayRes, absentRes, recentRes] = await Promise.all([
        axios.get(`${BASE_URL}/api/statistics/by-weekday?days=365`),
        axios.get(`${BASE_URL}/api/statistics/longest-absent?days=365`),
        axios.get(`${BASE_URL}/api/statistics/weekday-recent`),
      ]);
      const dayData = weekdayRes.data[vnDay] || {};
      const top6 = Object.entries(dayData)
        .map(([n, c]) => ({ number: n, count: c }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 6);
      const absentMap = {};
      (absentRes.data || []).forEach(r => { absentMap[r.number] = r.days_absent; });
      const recentSet = new Set((recentRes.data[vnDay]?.numbers) || []);
      const recentDate = recentRes.data[vnDay]?.date || null;
      return res.json({
        reply: `Top 6 số hay về ${dayLabel}:`,
        weekday_stats: {
          day_label: dayLabel,
          recent_date: recentDate,
          numbers: top6.map(({ number, count }) => ({
            number,
            count,
            days_absent: absentMap[number] ?? 0,
            is_recent: recentSet.has(number),
          })),
        },
      });
    } catch (err) {
      return res.status(500).json({ error: 'Lỗi khi lấy thống kê theo thứ.' });
    }
  }

  // Tra số theo giấc mơ
  const dreamKeywords = ['mơ thấy', 'nằm mơ', 'chiêm bao', 'giấc mơ', 'mơ thấy', 'mơ'];
  if (dreamKeywords.some(k => message.includes(k))) {
    try {
      const results = await searchDreamNumbers(message);
      if (results.length === 0) {
        return res.json({ reply: 'Không tìm thấy con số nào phù hợp với giấc mơ này trong sổ mơ.' });
      }
      const lines = results.map(r => `• ${r.keyword} → ${r.numbers}`).join('\n');
      return res.json({ reply: `🔮 Sổ mơ tìm thấy ${results.length} kết quả:\n${lines}` });
    } catch (err) {
      return res.status(500).json({ error: 'Lỗi khi tra sổ mơ.' });
    }
  }

  // Tổng hợp thống kê toàn diện cho 1 số (vd: "số 80 ok không", "số 07 thế nào")
  const numberSummaryTriggers = ['ok không', 'thế nào', 'như thế nào', 'có nên', 'hay không', 'đánh không', 'đánh được không', 'được không', 'nên đánh', 'có về không', 'về không'];
  const numberSummaryMatch = message.match(/(?:^|số\s*)(\d{1,2})(?:\s|$)/);
  const isNumberSummaryQuery = numberSummaryMatch && numberSummaryTriggers.some(t => message.includes(t));
  if (isNumberSummaryQuery) {
    try {
      const number = numberSummaryMatch[1].padStart(2, '0');
      const VN_DAYS = ['', '', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'CN'];
      const [absentRes, maxAbsentRes, avgCycleRes, coOccRes, weekdayRes, recentRes] = await Promise.all([
        axios.get(`${BASE_URL}/api/statistics/longest-absent?days=365`),
        axios.get(`${BASE_URL}/api/statistics/max-absent?nums=${number}`),
        axios.get(`${BASE_URL}/api/statistics/avg-cycle`),
        axios.get(`${BASE_URL}/api/statistics/co-occurrence?num=${number}&days=180`),
        axios.get(`${BASE_URL}/api/statistics/by-weekday?days=365`),
        axios.get(`${BASE_URL}/api/statistics/weekday-recent`),
      ]);

      const absentEntry = (absentRes.data || []).find(r => r.number === number);
      const daysAbsent = absentEntry?.days_absent ?? 0;
      const lastSeen = absentEntry?.last_seen || null;

      const maxAbsent = maxAbsentRes.data?.[0]?.max_days_absent ?? null;

      const cycleEntry = (avgCycleRes.data || []).find(r => r.number === number);
      const avgCycle = cycleEntry?.avg_cycle ?? null;
      const totalAppearances = cycleEntry?.appearances ?? 0;

      const coTop5 = (coOccRes.data?.results || []).slice(0, 5).map(r => r.number);

      // Best weekdays for this number
      const weekdayData = weekdayRes.data || {};
      const weekdayCounts = [];
      for (let d = 2; d <= 8; d++) {
        const cnt = weekdayData[d]?.[number] || 0;
        if (cnt > 0) weekdayCounts.push({ day: d, count: cnt });
      }
      weekdayCounts.sort((a, b) => b.count - a.count);
      const bestWeekdays = weekdayCounts.slice(0, 3).map(w => ({ day: VN_DAYS[w.day], count: w.count }));

      // Recent hits (last 14 days from weekday-recent data)
      const recentNumbers = new Set();
      for (let d = 2; d <= 8; d++) {
        (recentRes.data[d]?.numbers || []).forEach(n => recentNumbers.add(n));
      }
      const isRecentlyHit = recentNumbers.has(number);

      let reply = `Số ${number}: `;
      if (daysAbsent === 0) reply += `vừa về hôm nay.`;
      else reply += `đang gan ${daysAbsent} ngày.`;
      if (avgCycle) reply += ` Chu kỳ TB ${avgCycle} ngày.`;

      return res.json({
        reply,
        number_stats: {
          number,
          days_absent: daysAbsent,
          last_seen: lastSeen,
          max_absent: maxAbsent,
          avg_cycle: avgCycle,
          total_appearances: totalAppearances,
          best_weekdays: bestWeekdays,
          co_numbers: coTop5,
          is_recently_hit: isRecentlyHit,
        },
      });
    } catch (err) {
      console.error('[CHAT] number summary error:', err.message);
      return res.status(500).json({ error: 'Lỗi khi tổng hợp thống kê số.' });
    }
  }

  try {
    // Kiểm tra câu hỏi liên quan đến 1 con số cụ thể
    const match = message.match(/\b\d{1,2}\b/); // Tìm số có 1-2 chữ số
    if (match) {
      const number = match[0].padStart(2, '0'); // chuyển 9 -> 09
      const response = await axios.get(`${BASE_URL}/api/statistics/frequency?days=30&numbers=${number}`);
      const freqData = response.data;
      const daysAbsent = getDaysAbsent(freqData, number);

      let reply = '';
      if (daysAbsent === 0) {
        reply = `Số ${number} vừa mới ra hôm nay.`;
      } else if (daysAbsent === 1) {
        reply = `Số ${number} không ra hôm qua.`;
      } else {
        reply = `Số ${number} đã không ra trong ${daysAbsent} ngày gần nhất.`;
      }

      return res.json({ reply });
    }

  } catch (error) {
    console.error('Lỗi khi xử lý câu hỏi về số:', error);
    return res.status(500).json({ reply: 'Đã xảy ra lỗi khi kiểm tra số, vui lòng thử lại sau.' });
  }

  const date = parseDateFromMessage(message.toLowerCase());
  if (!date) {
    return res.status(400).json({ error: "Không xác định được ngày từ câu hỏi." });
  }

  try {
    const db = await dbPromise;
    const row = await db.all("SELECT g0 FROM xsmb WHERE result_date = ?", [date]);

    if (!row || !row[0] || !row[0].g0) {
      return res.status(404).json({ error: `Không có kết quả đề cho ngày ${date}` });
    }

    const g0 = row[0].g0.toString();
    const de = g0.slice(-2);

    return res.json({
      date,
      de,
      reply: `Đề ngày ${date} là ${de}`
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Lỗi truy vấn CSDL." });
  }
});

cron.schedule('00 3 * * *', async () => {
  console.log('[CRON] Tổng hợp và gửi 3 cầu lô lúc 9h');
  check3CauLo();
});

// ===================== HEALTH SYNC RELAY =====================

async function ensureHealthSyncTable() {
  const db = await dbPromise;
  await db.run(`
    CREATE TABLE IF NOT EXISTS health_sync (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device TEXT NOT NULL,
      steps INTEGER,
      calories INTEGER,
      hr INTEGER,
      floors INTEGER,
      date TEXT,
      ts INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

async function ensureHealthAlertsTable() {
  const db = await dbPromise;
  await db.run(`
    CREATE TABLE IF NOT EXISTS health_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device TEXT NOT NULL,
      hr INTEGER,
      ts INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'number' && Number.isInteger(v)) {
      fields[k] = { integerValue: String(v) };
    } else if (typeof v === 'number') {
      fields[k] = { doubleValue: v };
    } else {
      fields[k] = { stringValue: String(v ?? '') };
    }
  }
  return fields;
}

app.post('/api/health-sync', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { device, steps, calories, hr, floors, date, ts } = req.body;

  if (!device) return res.status(400).json({ error: 'Missing device' });

  const tsVal = ts ?? 0;
  const db = await dbPromise;
  try {
    const existing = await db.get(
      'SELECT id FROM health_sync WHERE device = ? AND ts = ?', [device, tsVal]
    );
    if (!existing) {
      await db.run(
        `INSERT INTO health_sync (device, steps, calories, hr, floors, date, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [device, steps ?? 0, calories ?? 0, hr ?? 0, floors ?? 0, date ?? '', tsVal]
      );
    }
  } catch (err) {
    console.error('[HEALTH-SYNC] SQLite error:', err.message);
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const apiKey    = process.env.FIREBASE_API_KEY;
  // Dùng ts làm document ID → tự nhiên dedup khi retry
  const fsUrl     = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/my_data/${device}/records/${tsVal}?key=${apiKey}`;

  try {
    await axios.patch(fsUrl, {
      fields: toFirestoreFields({ steps: steps ?? 0, calories: calories ?? 0, hr: hr ?? 0, floors: floors ?? 0, date: date ?? '', ts: tsVal })
    });
    res.json({ ok: true });
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data?.error?.message || err.message;
    console.error('[HEALTH-SYNC] Firestore error:', status, msg);
    res.status(502).json({ ok: false, error: msg });
  }
});

app.post('/api/health-sync/alerts', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { device, records } = req.body;

  if (!device || !records) return res.status(400).json({ error: 'Missing device or records' });

  let parsedRecords;
  try {
    parsedRecords = typeof records === 'string' ? JSON.parse(records) : records;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid records format' });
  }

  if (!Array.isArray(parsedRecords) || parsedRecords.length === 0) {
    return res.status(400).json({ error: 'records must be a non-empty array' });
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const apiKey    = process.env.FIREBASE_API_KEY;
  const db = await dbPromise;

  for (const record of parsedRecords) {
    const tsVal = record.ts ?? 0;
    const hrVal = record.hr ?? 0;

    try {
      const existing = await db.get(
        'SELECT id FROM health_alerts WHERE device = ? AND ts = ?', [device, tsVal]
      );
      if (!existing) {
        await db.run(
          `INSERT INTO health_alerts (device, hr, ts) VALUES (?, ?, ?)`,
          [device, hrVal, tsVal]
        );
      }
    } catch (err) {
      console.error('[HEALTH-ALERTS] SQLite error:', err.message);
    }

    try {
      const fsUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/my_data/${device}/alerts/${tsVal}?key=${apiKey}`;
      await axios.patch(fsUrl, {
        fields: toFirestoreFields({ device, hr: hrVal, ts: tsVal })
      });
    } catch (err) {
      console.error('[HEALTH-ALERTS] Firestore error:', err.response?.status, err.message);
    }
  }

  res.json({ ok: true, count: parsedRecords.length });
});

// ===================== END HEALTH SYNC RELAY =====================

app.listen(PORT, async () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  try {
    const db = await dbPromise;
    await db.run(`
      CREATE TABLE IF NOT EXISTS max_absent_stats (
        number TEXT PRIMARY KEY,
        max_days_absent INTEGER,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    const row = await db.get(`SELECT COUNT(*) as cnt FROM max_absent_stats`);
    if (!row || row.cnt === 0) {
      console.log('[STARTUP] Chưa có dữ liệu max absent, đang tính lần đầu...');
      computeAndSaveMaxAbsent();
    }
    await importDreamNumbers();
    await ensureHealthSyncTable();
    await ensureHealthAlertsTable();
  } catch (err) {
    console.error('[STARTUP] Lỗi khi kiểm tra max absent:', err.message);
  }
});
