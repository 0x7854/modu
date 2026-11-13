#!/usr/bin/env node
import { createReaderServer, DEFAULT_PORT } from './lib/reader-server.js';

function parsePort() {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--port' && args[index + 1]) return Number(args[index + 1]);
    if (args[index].startsWith('--port=')) return Number(args[index].split('=')[1]);
  }
  if (process.env.MD_READER_PORT) return Number(process.env.MD_READER_PORT);
  return DEFAULT_PORT;
}

const port = parsePort();
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('墨读：端口无效。请使用 --port 4648 这样的端口号。');
  process.exit(1);
}

const server = createReaderServer();
let stopping = false;

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n墨读：收到 ${signal}，正在停止…`);
  server.readerShutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`墨读：端口 ${port} 已被占用。可能是墨读已在运行，请直接打开 http://127.0.0.1:${port} ；或运行 npm start -- --port 4658。`);
  } else {
    console.error(`墨读：服务启动失败：${error.message}`);
  }
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  const actualPort = typeof address === 'object' ? address.port : port;
  console.log('');
  console.log('  墨读 · 本地 Markdown 阅读器');
  console.log(`  http://127.0.0.1:${actualPort}`);
  console.log('');
  console.log('  实时读取原文件 · 按 Ctrl+C 停止');
  console.log('');
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
