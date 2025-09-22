// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'wa-ai-bot',
    script: 'dist/index.js',
    env: { NODE_ENV: 'production' },
    max_memory_restart: '400M'
  }]
}
