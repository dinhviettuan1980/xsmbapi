const mysql = require('mysql2/promise');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

(async () => {
  // Kết nối MySQL
  const mysqlConn = await mysql.createConnection({
    host: '103.61.123.106',
    user: 'user_db',
    password: 'A8&5FCN~gBaa', // sửa lại nếu cần
    database: 'xsmb'
  });

  // Lấy toàn bộ dữ liệu
  const [rows] = await mysqlConn.execute('SELECT * FROM xsmb');

  // Kết nối SQLite
  const sqliteDb = await open({
    filename: './data.sqlite',
    driver: sqlite3.Database
  });

  const insertSQL = `
    INSERT INTO xsmb (result_date, g0, g1, g2, g3, g4, g5, g6, g7)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  for (const row of rows) {
    await sqliteDb.run(insertSQL, [
      row.result_date,
      row.g0, row.g1, row.g2, row.g3,
      row.g4, row.g5, row.g6, row.g7
    ]);
  }

  console.log(`✅ Đã chuyển ${rows.length} dòng từ MySQL sang SQLite`);

  await mysqlConn.end();
  await sqliteDb.close();
})();
