const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');

async function fixDates() {
  const db = await open({
    filename: path.join(__dirname, 'data.sqlite'),
    driver: sqlite3.Database
  });

  const rows = await db.all('SELECT rowid, result_date FROM xsmb');

  for (const row of rows) {
    const raw = row.result_date;

    if (!isNaN(raw)) {
      const d = new Date(parseFloat(raw));
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const formatted = `${yyyy}-${mm}-${dd}`;

      await db.run('UPDATE xsmb SET result_date = ? WHERE rowid = ?', formatted, row.rowid);
      console.log(`✅ Updated rowid ${row.rowid}: ${formatted}`);
    }
  }

  await db.close();
}

fixDates().catch(console.error);
