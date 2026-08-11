module.exports = {
  apps: [
    {
      name: 'sca-server',
      script: 'apps/server/dist/index.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
      },
      instances: 1,
      autorestart: true,
      max_memory_restart: '4G',
    },
  ],
};
