const path = require('node:path');
const cwd = __dirname;
const base = {
  cwd,
  script: path.join(cwd, 'scripts/run.mjs'),
  interpreter: process.execPath,
  exec_mode: 'fork',
  instances: 1,
  autorestart: true,
  restart_delay: 5000,
  min_uptime: '10s',
  max_restarts: 20,
  kill_timeout: 180000,
  time: true,
  merge_logs: true,
};
module.exports = {
  apps: [
    { ...base, name: 'rounds', args: ['tsx', 'src/rounds.ts'], max_memory_restart: '2G' },
    { ...base, name: 'snapshot', args: ['tsx', 'src/snapshot.ts'], filter_env: ['PAYOUT_PRIVATE_KEY'], max_memory_restart: '768M' },
    { ...base, name: 'data', args: ['tsx', 'src/api.ts'], filter_env: ['PAYOUT_PRIVATE_KEY', 'TELEGRAM_BOT_TOKEN'], max_memory_restart: '512M' },
  ],
};
