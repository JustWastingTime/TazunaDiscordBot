/** pm2 start deploy/ecosystem.config.cjs */
// PORT defaults to 3010, not 3000: 3000 is commonly taken by another site on the
// same droplet. Override without editing this file by exporting TAZUNA_PORT first.
module.exports = {
  apps: [
    {
      name: 'tazuna',
      cwd: __dirname + '/..',
      script: 'scripts/app.js',
      instances: 1,
      autorestart: true,
      max_memory_restart: '700M',
      env: { NODE_ENV: 'production', PORT: process.env.TAZUNA_PORT || 3010 },
    },
  ],
};
