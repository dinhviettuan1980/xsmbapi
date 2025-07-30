const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');

(async () => {
  // // Xóa file cũ nếu cần
  // if (fs.existsSync('data.sqlite')) {
  //   fs.unlinkSync('data.sqlite');
  // }

  const db = await open({
    filename: './data.sqlite',
    driver: sqlite3.Database
  });

  // await db.exec(`
  //   CREATE TABLE xsmb (
  //     result_date TEXT PRIMARY KEY,
  //     g0 TEXT,
  //     g1 TEXT,
  //     g2 TEXT,
  //     g3 TEXT,
  //     g4 TEXT,
  //     g5 TEXT,
  //     g6 TEXT,
  //     g7 TEXT
  //   )
  // `);

  await db.exec(`DROP TABLE IF EXISTS log;
  CREATE TABLE log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT,
    value TEXT,
    createdate TEXT DEFAULT (datetime('now'))
  )`);  

  console.log('✅ SQLite file created and xsmb table initialized');
})();
