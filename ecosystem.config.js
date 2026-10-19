module.exports = {
  apps: [
    {
      name: 'vpanel',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: '1G',
      // server.js needs up to 8s to write the recovery code on stop; pm2's
      // default kill_timeout (1600ms) SIGKILLed it mid-export every time.
      kill_timeout: 12000,
      env: {
        NODE_ENV: 'production',
      },
      out_file: 'storage/logs/pm2-out.log',
      error_file: 'storage/logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
