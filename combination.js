
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
  return Array.from(result);
}

router.get('/api/combination', (req, res) => {
  const number = req.query.number;
  if (!number || number.length < 2 || number.length > 5) {
    return res.status(400).json({ error: "Invalid number length (must be 2-5 digits)" });
  }

  const digits = number.split('');
  const response = {};

  if (digits.length >= 2) {
    response['2_digit_combinations'] = getCombinations(digits, 2);
  }
  if (digits.length >= 3) {
    response['3_digit_combinations'] = getCombinations(digits, 3);
  }
  if (digits.length >= 4) {
    response['4_digit_combinations'] = getCombinations(digits, 4);
  }

  res.json(response);
});

module.exports = router;
