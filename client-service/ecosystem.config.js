module.exports = {
  apps: [{
    name: 'api',
    script: './dist/server.js',
    instances: 'max',          // one worker per vCPU
    exec_mode: 'cluster',
    max_memory_restart: '800M', // safety net against leaks
    kill_timeout: 25000,        // give shutdown() time to drain
    wait_ready: false,
    env: { NODE_ENV: 'production', PORT: 3000 }
  }]
};