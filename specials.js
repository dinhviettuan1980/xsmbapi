
const express = require('express');
const router = express.Router();
const db = require('./db');

function getVietnameseWeekday(dateString) {
  const date = new Date(dateString);
  const weekdays = ["CN", "Thứ 2", "Thứ 3", "Thứ 4", "Thứ 5", "Thứ 6", "Thứ 7"];
  return weekdays[date.getDay()];
}

router.get('/api/specials/2-months', async (req, res) => {
  try {
    const [rows] = await db.execute(
      "SELECT result_date, g0 FROM xsmb WHERE result_date >= CURDATE() - INTERVAL 60 DAY ORDER BY result_date DESC"
    );

    const formatted = rows.map(row => ({
      date: row.result_date,
      weekday: getVietnameseWeekday(row.result_date),
      special: row.g0
    }));

    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
