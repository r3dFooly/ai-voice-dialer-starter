/**
 * PM2 ecosystem — AI voice dialer backend.
 *
 * Two long-running processes:
 *   - voice-dialer     : server.js  — HTTP + Retell custom-LLM websocket turn loop
 *   - dialer-scheduler : scheduler.js — polls the queue and fires outbound calls
 *
 * Start:   pm2 start ecosystem.config.js && pm2 save
 * Logs:    pm2 logs voice-dialer --lines 30
 *
 * SECRETS: none live here. Each process loads backend/.env via dotenv at startup.
 * Do NOT put API keys in this file and never commit a real .env.
 *
 * PM2 REPOINT TRAP: if you ever migrate the checkout path, delete + recreate the
 * processes (`pm2 delete voice-dialer dialer-scheduler` then start) rather than
 * restart — PM2 pins env.pm_exec_path from the saved dump and can relaunch the
 * OLD path. Strip pm_*/PM2_* vars from any hand-built env before pm2 start.
 */
module.exports = {
  apps: [
    {
      name: 'voice-dialer',
      script: 'server.js',
      cwd: __dirname + '/backend',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'dialer-scheduler',
      script: 'scheduler.js',
      cwd: __dirname + '/backend',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      env: { NODE_ENV: 'production' },
    },
  ],
};
