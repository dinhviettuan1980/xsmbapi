const express = require('express');
const cron = require('node-cron');
const fetchAndSaveXSMB = require('./crawler');
const fetchBulkXSMB = require('./crawler_bulk');
const sendTelegramMessage = require('./telegram');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const dbPromise = require('./db');
require('dotenv').config();
const cors = require('cors');
const combinationRoute = require('./combination');
const combinationAdvancedRoute = require('./combination-advanced');
const classifyRoute = require('./classify-two-digit');
const specialsRoute = require('./specials');
const verifyGoogleToken = require('./middlewares/authMiddleware');
const getServerInfo = require('./serverInfo');

const app = express();
const PORT = process.env.PORT;

app.use(cors());

app.use(express.json());

app.use(combinationRoute);
app.use(combinationAdvancedRoute);
app.use(classifyRoute);
app.use(specialsRoute);




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

app.get('/crawl', async (req, res) => {
  try {
    await fetchAndSaveXSMB();
    res.send('Crawled XSMB data manually.');
  } catch (error) {
    res.status(500).send('Error during manual crawl: ' + error.message);
  }
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
      SELECT result_date, g0, g1, g2, g3, g4, g5, g6, g7 FROM xsmb ORDER BY result_date DESC LIMIT 91
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
    const res = await axios.get('http://localhost:8001/api/tk-cau-ong-phong');
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
    const res2 = await axios.get('http://localhost:8001/api/tk-cau-lo-pascal');
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
    const res3 = await axios.get('http://localhost:8001/api/tk-cau-lo-roi');
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

cron.schedule('34 11 * * *', () => {
  console.log('[CRON] Running XSMB crawler at 18h45');
  fetchAndSaveXSMB();
});

cron.schedule('31 11 * * *', () => {
  console.log('[CRON] Running XSMB crawler at 18h45');
  fetchAndSaveXSMB();
});

cron.schedule('29 11 * * *', () => {
  console.log('[CRON] Running XSMB crawler at 18h45');
  fetchAndSaveXSMB();
});

cron.schedule('00 9 * * *', () => {
  console.log('[CRON] Check cau lo at 16h');
  checkCauLo();
});

async function check3CauLo() {
  try {
    const [res1, res2, res3] = await Promise.all([
      axios.get('http://localhost:8001/api/tk-cau-ong-phong'),
      axios.get('http://localhost:8001/api/tk-cau-lo-pascal'),
      axios.get('http://localhost:8001/api/tk-cau-lo-roi'),
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
    const newContent = { isUpdate: false };
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
      root: 'http://www.tuandv.asia',
      filename: 'src/manager.jsc',
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

cron.schedule('00 3 * * *', async () => {
  console.log('[CRON] Tổng hợp và gửi 3 cầu lô lúc 9h');
  check3CauLo();
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
