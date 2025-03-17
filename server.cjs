/**
 * CommonJS入口文件
 * =========================================================
 * 用于加载ES模块格式的api-server.js
 */

// 使用子进程方式运行ES模块
const { spawn } = require('child_process');
const path = require('path');

// 获取api-server.js的绝对路径
const apiServerPath = path.resolve(__dirname, 'api-server.js');

// 使用node命令运行ES模块
const child = spawn('node', [apiServerPath], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || 'production',
    PORT: process.env.PORT || 3000,
    DEBUG_MODE: process.env.DEBUG_MODE || 'false'
  }
});

// 处理子进程事件
child.on('error', (err) => {
  console.error('启动失败:', err);
  process.exit(1);
});

child.on('exit', (code) => {
  if (code !== 0) {
    console.error(`进程退出，退出码: ${code}`);
    process.exit(code);
  }
});

// 处理进程信号
process.on('SIGTERM', () => {
  child.kill('SIGTERM');
});

process.on('SIGINT', () => {
  child.kill('SIGINT');
}); 