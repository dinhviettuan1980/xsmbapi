
const express = require('express');
const router = express.Router();

router.get('/api/classify-two-digit', (req, res) => {
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
  }

  for (let t = 0; t <= 9; t++) {
    results[`tong_${t}`] = [];
    for (let i = 0; i < 100; i++) {
      const num = i.toString().padStart(2, '0');
      const d1 = parseInt(num[0]);
      const d2 = parseInt(num[1]);
      if (d1 + d2 === t) {
        results[`tong_${t}`].push(num);
      }
    }
  }

  res.json(results);
});

module.exports = router;
