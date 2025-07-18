const express = require('express');
const router = express.Router();
const axios = require('axios');

// Hàm tạo ra kết quả phân loại 00-99
function generateResults() {
  const results = {
    chan_chan: [],
    le_le: [],
    chan_le: [],
    le_chan: [],
    kep_bang: [],
    to_to: [],
    be_be: [],
    to_be: [],
    be_to: [],
  };

  for (let t = 0; t <= 9; t++) {
    results[`tong_${t}`] = [];
  }

  for (let i = 0; i < 100; i++) {
    const num = i.toString().padStart(2, '0');
    const d1 = parseInt(num[0]);
    const d2 = parseInt(num[1]);

    if (d1 % 2 === 0 && d2 % 2 === 0) results.chan_chan.push(num);
    if (d1 % 2 === 1 && d2 % 2 === 1) results.le_le.push(num);
    if (d1 % 2 === 0 && d2 % 2 === 1) results.chan_le.push(num);
    if (d1 % 2 === 1 && d2 % 2 === 0) results.le_chan.push(num);
    if (d1 === d2) results.kep_bang.push(num);
    if (d1 > 4 && d2 > 4) results.to_to.push(num);
    if (d1 < 5 && d2 < 5) results.be_be.push(num);
    if (d1 > 4 && d2 < 5) results.to_be.push(num);
    if (d1 < 5 && d2 > 4) results.be_to.push(num);

    const tong = (d1 + d2) % 10;
    results[`tong_${tong}`].push(num);
  }

  return results;
}

// API 1: /api/classify-two-digit
router.get('/api/classify-two-digit', async (req, res) => {
  try {
    const results = generateResults();

    const specialsRes = await axios.get('http://localhost:8001/api/specials/recent');
    const specials = specialsRes.data;

    const types = Object.keys(results).filter(key => Array.isArray(results[key]));
    const missingDays = {};

    for (const type of types) {
      missingDays[type] = undefined;
    }

    let dayIndex = 0;

    for (const item of specials) {
      let number = item.number;
      if (typeof number === 'string') {
        number = parseInt(number);
      }

      const lastTwoDigits = number % 100;
      const lastTwoDigitsStr = lastTwoDigits.toString().padStart(2, '0');

      for (const type of types) {
        if (missingDays[type] === undefined) {
          const numbers = results[type];
          if (numbers.includes(lastTwoDigitsStr)) {
            missingDays[type] = dayIndex;
          }
        }
      }

      const unfinished = types.filter(type => missingDays[type] === undefined);
      if (unfinished.length === 0) {
        break;
      }

      dayIndex += 1;
    }

    for (const type of types) {
      if (missingDays[type] === undefined) {
        missingDays[type] = specials.length;
      }
      results[`${type}_missing`] = missingDays[type];
    }

    res.json(results);

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// API 2: /api/generate-combinations
router.post('/api/generate-combinations', async (req, res) => {
  try {
    const { group, cang3, cang4 } = req.body;

    if (!group) {
      return res.status(400).json({ error: 'Thiếu tham số group' });
    }

    const results = generateResults();
    const numbers = results[group];

    if (!numbers) {
      return res.status(400).json({ error: 'Nhóm không hợp lệ' });
    }

    const combinations = numbers.map(twoDigit => {
      const two = twoDigit;
      const three = cang3 !== undefined && cang3 !== "" ? `${cang3}${twoDigit}` : null;
      const four = (cang3 !== undefined && cang3 !== "" && cang4 !== undefined && cang4 !== "")
        ? `${cang4}${cang3}${twoDigit}`
        : null;

      return {
        twoDigit: two,
        ...(three && { threeDigit: three }),
        ...(four && { fourDigit: four })
      };
    });

    res.json(combinations);

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;
