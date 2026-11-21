// PM2 process file: keeps the bot running and restarts it if it crashes.
//   npm install -g pm2
//   pm2 start ecosystem.config.cjs
//   pm2 save          (remember across reboots; on Windows see README)
module.exports = {
  apps: [
    {
      name: 'crypto-portfolio',
      script: 'src/index.ts',
      interpreter: 'node',
      interpreter_args: '--disable-warning=ExperimentalWarning',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      kill_timeout: 12000,
      time: true,
    },
  ],
};
