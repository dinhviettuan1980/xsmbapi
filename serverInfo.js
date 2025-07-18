const os = require('os');
const path = require('path');
const checkDiskSpace = require('check-disk-space').default;

async function getServerInfo() {
  const uptimeSec = os.uptime();
  const uptimeHr = Math.floor(uptimeSec / 3600);
  const uptimeMin = Math.floor((uptimeSec % 3600) / 60);

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memUsagePercent = (usedMem / totalMem) * 100;

  const cpus = os.loadavg(); // [1m, 5m, 15m]

  let diskInfo;
  try {
    // Chỉ định root path: '/' cho Linux/macOS, 'C:' cho Windows
    const rootPath = path.parse(process.cwd()).root;
    const info = await checkDiskSpace(rootPath);
    diskInfo = {
      total: `${(info.size / 1024 / 1024 / 1024).toFixed(2)} GB`,
      free: `${(info.free / 1024 / 1024 / 1024).toFixed(2)} GB`,
      usedPercent: `${(((info.size - info.free) / info.size) * 100).toFixed(1)}%`
    };
  } catch (err) {
    console.error('Disk check error:', err);
    diskInfo = null;
  }

  return {
    uptime: `${uptimeHr}h ${uptimeMin}m`,
    memory: {
      total: `${(totalMem / 1024 / 1024 / 1024).toFixed(2)} GB`,
      used: `${(usedMem / 1024 / 1024 / 1024).toFixed(2)} GB`,
      usage: `${memUsagePercent.toFixed(1)}%`
    },
    cpuLoad: {
      '1m': cpus[0].toFixed(2),
      '5m': cpus[1].toFixed(2),
      '15m': cpus[2].toFixed(2),
    },
    disk: diskInfo
  };
}

module.exports = getServerInfo;
