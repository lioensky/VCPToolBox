module.exports = {
  apps: [
    {
      name: 'vcp-main',
      script: 'server.js',
      cwd: '/usr/src/app',
      watch: false,
      autorestart: true,
    },
    {
      name: 'vcp-admin',
      script: 'adminServer.js',
      cwd: '/usr/src/app',
      watch: false,
      autorestart: true,
    },
  ],
};
