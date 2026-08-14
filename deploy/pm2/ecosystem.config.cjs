const path = require('path');

const appRoot = path.resolve(__dirname, '../..');

module.exports = {
  apps: [
    {
      name: 'evolution-api',
      cwd: appRoot,
      script: 'dist/main.js',
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 30000,
      listen_timeout: 60000,
      time: true,
      merge_logs: true,
      env_production: {
        NODE_ENV: 'PROD',
      },
    },
  ],
};