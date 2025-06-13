const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

async function getDB() {
  return open({
    filename: path.join(__dirname, 'data.sqlite'),
    driver: sqlite3.Database
  });
}

module.exports = getDB();
