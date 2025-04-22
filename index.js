const express = require('express');
const cron = require('node-cron');
const fetchAndSaveXSMB = require('./crawler');
const fetchBulkXSMB = require('./crawler_bulk');
const sendTelegramMessage = require('./telegram');
const db = require('./db');
require('dotenv').config();
const cors = require('cors');
const combinationRoute = require('./combination');
const combinationAdvancedRoute = require('./combination-advanced');
const classifyRoute = require('./classify-two-digit');
const specialsRoute = require('./specials');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(combinationRoute);
app.use(combinationAdvancedRoute);
app.use(classifyRoute);
app.use(specialsRoute);

app.get('/', (req, res) => {
  res.send('XSMB API is running');
});

app.get('/api/history', async (req, res) => {
  const date = req.query.date;
  if (!date) return res.status(400).json({ error: "Missing 'date' query param" });

  try {
    const [rows] = await db.execute('SELECT * FROM xsmb WHERE result_date = ?', [date]);
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
  try {
    const [rows] = await db.execute('SELECT * FROM xsmb ORDER BY result_date DESC LIMIT 1');
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
  const { days, numbers } = req.query;

  if (!days || !numbers) {
    return res.status(400).json({ error: "Missing 'days' or 'numbers' query param" });
  }

  const limit = parseInt(days);
  if (isNaN(limit) || limit <= 0) {
    return res.status(400).json({ error: "'days' must be a positive number" });
  }

  // Hàm tách 3 chữ số thành 2 số đảo đầu – đuôi
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

  // Tách chuỗi và mở rộng nếu cần
  const inputList = numbers.split(',').map(n => n.trim()).filter(Boolean);
  const numberList = expandNumbers(inputList); // Ex: ['12', '21', '56', '65', ...]

  try {
    const [rows] = await db.query(`
      SELECT result_date, g0, g1, g2, g3, g4, g5, g6, g7
      FROM xsmb
      ORDER BY result_date DESC
      LIMIT ${limit}
    `);

    const result = {};

    rows.forEach(row => {
      const date = new Date(row.result_date).toISOString().slice(0, 10);
      result[date] = {};

      // Gán mặc định 0 cho tất cả số đang theo dõi
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
  const { days } = req.query;

  if (!days) {
    return res.status(400).json({ error: "Missing 'days' query param" });
  }

  const limit = parseInt(days);
  if (isNaN(limit) || limit <= 0) {
    return res.status(400).json({ error: "'days' must be a positive number" });
  }

  try {
    const [rows] = await db.query(`
      SELECT g0, g1, g2, g3, g4, g5, g6, g7
      FROM xsmb
      ORDER BY result_date DESC
      LIMIT ${limit}
    `);

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
  const { days } = req.query;
  const limit = parseInt(days) || 30;

  try {
    const [rows] = await db.query(`
      SELECT result_date, g0, g1, g2, g3, g4, g5, g6, g7
      FROM xsmb
      ORDER BY result_date DESC
      LIMIT ${limit}
    `);

    const numberLastSeen = {};
    const allDates = [];

    rows.forEach(row => {
      const dateStr = row.result_date.toISOString().slice(0, 10);
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

    // Ngày mới nhất để tính khoảng cách
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

    results.sort((a, b) => b.days_absent - a.days_absent); // sắp theo ngày vắng mặt giảm dần

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/specials/recent", async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT result_date, g0 FROM xsmb ORDER BY result_date DESC LIMIT 60"
    );

    const data = rows.map(r => {
      const date = r.result_date.toISOString().split("T")[0];
      const weekday = new Date(r.result_date).getDay(); // 0 (Sun) → 6 (Sat)
      const vnWeekday = weekday === 0 ? 8 : weekday + 1; // CN = 8, Thứ 2 = 2
      return { date, number: r.g0, weekday: vnWeekday };
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

cron.schedule('45 11 * * *', () => {
  console.log('[CRON] Running XSMB crawler at 19h');
  fetchAndSaveXSMB();
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
