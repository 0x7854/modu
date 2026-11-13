#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { CloudStore } from './lib/store.js';

function usage() {
  console.log(`墨读云文档库 · 账户管理

用法：
  node cloud/manage.js add-user <用户名>
  node cloud/manage.js list-users
  node cloud/manage.js rotate-token <用户名>
  node cloud/manage.js reset-password <用户名>

数据目录：
  --data <目录>  或环境变量 MODU_CLOUD_DATA（默认 ./data）

密码：
  交互输入；非交互环境可用 MODU_USER_PASSWORD 提供。
  密码至少 10 个字符。同步令牌只在创建/轮换时显示一次。`);
}

function parseArgs(argv) {
  const args = [...argv];
  let dataDir = process.env.MODU_CLOUD_DATA || path.join(process.cwd(), 'data');
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--data' && args[index + 1]) {
      dataDir = args[index + 1];
      index += 1;
    } else if (args[index].startsWith('--data=')) {
      dataDir = args[index].slice('--data='.length);
    } else {
      rest.push(args[index]);
    }
  }
  return { dataDir: path.resolve(dataDir), command: rest[0] || '', name: rest[1] || '' };
}

async function readLine(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

async function promptSecret(question) {
  if (process.env.MODU_USER_PASSWORD) return process.env.MODU_USER_PASSWORD;
  if (!process.stdin.isTTY) {
    return readLine(question);
  }
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let value = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          stdin.setRawMode?.(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (char === '\r' || char === '\n') {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (char >= ' ') {
          value += char;
          process.stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function readNewPassword() {
  const first = await promptSecret('设置密码（至少 10 位）：');
  const second = await promptSecret('再次输入密码：');
  if (first !== second) {
    throw new Error('两次输入的密码不一致。');
  }
  return first;
}

async function main() {
  const { dataDir, command, name } = parseArgs(process.argv.slice(2));
  if (!command || ['help', '-h', '--help'].includes(command)) {
    usage();
    return;
  }
  const store = await new CloudStore(dataDir).init();

  if (command === 'list-users') {
    const users = await store.listUsers();
    if (!users.length) {
      console.log('还没有账户。使用 add-user 创建。');
      return;
    }
    for (const user of users) {
      console.log(`${user.username}\t${user.id}\t令牌轮换：${user.syncTokenRotatedAt || '—'}`);
    }
    return;
  }

  if (!name) throw new Error('请提供用户名。');
  const users = await store.listUsers();
  const existing = users.find((user) => user.username === name.toLowerCase());

  if (command === 'add-user') {
    const password = await readNewPassword();
    const created = await store.addUser(name, password);
    console.log('');
    console.log(`已创建账户：${created.user.username}`);
    console.log('同步令牌（只显示这一次，请存进 Mac 墨读的云端设置）：');
    console.log(created.syncToken);
    console.log('');
    console.log('阅读登录使用同一用户名与刚才设置的密码；同步令牌不能用于网页登录。');
    return;
  }

  if (command === 'rotate-token') {
    if (!existing) throw new Error('用户不存在。');
    const rotated = await store.rotateSyncToken(existing.id);
    console.log(`已为 ${rotated.user.username} 轮换同步令牌（只显示这一次）：`);
    console.log(rotated.syncToken);
    console.log('旧令牌立即失效；Mac 需要填写新令牌。');
    return;
  }

  if (command === 'reset-password') {
    if (!existing) throw new Error('用户不存在。');
    const password = await readNewPassword();
    await store.resetPassword(existing.id, password);
    console.log(`已重置 ${existing.username} 的阅读密码。同步令牌保持不变。`);
    return;
  }

  throw new Error(`未知命令：${command}`);
}

main().catch((error) => {
  console.error(`失败：${error.message}`);
  process.exit(1);
});
