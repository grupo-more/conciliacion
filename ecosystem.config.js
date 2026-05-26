module.exports = {
  apps: [{
    name: 'conciliacion',
    script: './node_modules/next/dist/bin/next',
    args: 'start -H 0.0.0.0',
    cwd: __dirname,
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
