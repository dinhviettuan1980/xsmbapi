
const express = require('express');
const router = express.Router();

function getCombinations(str, length) {
  const result = new Set();

  function permute(path, used) {
    if (path.length === length) {
      result.add(path.join(''));
      return;
    }
    for (let i = 0; i < str.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      path.push(str[i]);
      permute(path, used);
      path.pop();
      used[i] = false;
    }
  }

  permute([], []);
  return result;
}

router.get('/api/combination-advanced', (req, res) => {
  const number = req.query.number;
  const swapFrom = req.query.swapFrom;
  const swapTo = req.query.swapTo;

  if (!number || number.length < 2 || number.length > 5) {
    return res.status(400).json({ error: "Invalid number length (must be 2-5 digits)" });
  }

  if (!swapFrom || !swapTo || swapFrom.length !== 1 || swapTo.length !== 1) {
    return res.status(400).json({ error: "Invalid swapFrom or swapTo" });
  }

  const digitsOriginal = number.split('');
  const digitsSwapped = digitsOriginal.map(d => (d === swapFrom ? swapTo : d));

  const result = {
    "2_digit_combinations": new Set(),
    "3_digit_combinations": new Set(),
    "4_digit_combinations": new Set()
  };

  [digitsOriginal, digitsSwapped].forEach(digits => {
    if (digits.length >= 2) {
      getCombinations(digits, 2).forEach(x => result["2_digit_combinations"].add(x));
    }
    if (digits.length >= 3) {
      getCombinations(digits, 3).forEach(x => result["3_digit_combinations"].add(x));
    }
    if (digits.length >= 4) {
      getCombinations(digits, 4).forEach(x => result["4_digit_combinations"].add(x));
    }
  });

  res.json({
    "2_digit_combinations": Array.from(result["2_digit_combinations"]),
    "3_digit_combinations": Array.from(result["3_digit_combinations"]),
    "4_digit_combinations": Array.from(result["4_digit_combinations"])
  });
});

module.exports = router;
