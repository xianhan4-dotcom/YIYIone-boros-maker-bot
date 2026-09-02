#!/usr/bin/env node
/**
 * log-monitor.js
 * ------------------------------------------------------------
 * 实时监测正在运行的 Node.js 程序的日志输出，按自定义规则识别"异常"，
 * 并把异常单独写入 anomalies.jsonl，方便之后用"日志脉搏"面板分析。
 *
 * 用法（在 PowerShell / 终端里）：
 *   node log-monitor.js -- node bot.js
 *   node log-monitor.js -- node bot.js --some-flag value
 *
 * 也可以直接传一整条命令（内部用 shell 执行）：
 *   node log-monitor.js "node bot.js --some-flag value"
 *
 * 终端里看到的内容和平时一模一样（原样转发），
 * 只是匹配到规则的行会额外被记录到 anomalies.jsonl 里。
 *
 * 想自定义"什么算异常"，改下面的 RULES 数组就行：
 *   - test 可以是字符串（包含匹配，大小写不敏感）或正则表达式
 *   - level 用 fatal / error / warn 三档，决定颜色和严重程度排序
 * ------------------------------------------------------------
 */

'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============== 1. 在这里自定义你的异常规则 ==============
const RULES = [
  { name: '保证金不足/下单失败', test: /❌|not enough margin|insufficient|失败/i, level: 'error' },
  { name: '未捕获异常',        test: /exception|uncaught|unhandled|崩溃|crash/i,    level: 'fatal' },
  { name: '拉黑过滤(波动异常)',  test: '🚫',                                          level: 'warn' },
  { name: '超时/重试',         test: /超时|timeout|重试|retry/i,                     level: 'warn' },
  // 在下面继续加你自己的规则，比如：
  // { name: 'API限流', test: /rate limit|429/i, level: 'warn' },
];

// ============== 2. 基本配置 ==============
const OUTPUT_FILE = path.join(process.cwd(), 'anomalies.jsonl');
const HEARTBEAT_MS = 5 * 60 * 1000; // 每5分钟打印一次存活状态，0 表示关闭
const SEV_RANK = { fatal: 3, error: 2, warn: 1 };
const COLOR = { fatal: '\x1b[31m', error: '\x1b[31m', warn: '\x1b[33m', reset: '\x1b[0m' };

// ============== 3. 解析命令行，拿到要监测的启动命令 ==============
const argv = process.argv.slice(2);
let cmd, args, useShell;
const dashIdx = argv.indexOf('--');
if (dashIdx !== -1) {
  const rest = argv.slice(dashIdx + 1);
  if (!rest.length) { usage(); process.exit(1); }
  cmd = rest[0];
  args = rest.slice(1);
  useShell = false;
} else if (argv.length) {
  cmd = argv.join(' ');
  args = [];
  useShell = true;
} else {
  usage();
  process.exit(1);
}

function usage(){
  console.error([
    '用法:',
    '  node log-monitor.js -- node bot.js [其他参数...]',
    '  node log-monitor.js "node bot.js --flag value"',
  ].join('\n'));
}

// ============== 4. 启动子进程，原样转发输出，同时按行检测异常 ==============
const outStream = fs.createWriteStream(OUTPUT_FILE, { flags: 'a' });

let totalLines = 0;
let anomalyCounts = { fatal: 0, error: 0, warn: 0 };

console.log('—'.repeat(50));
console.log('🩺 日志监测器已启动');
console.log('   监测命令: ' + (useShell ? cmd : [cmd].concat(args).join(' ')));
console.log('   异常记录写入: ' + OUTPUT_FILE);
console.log('—'.repeat(50));

const child = useShell
  ? spawn(cmd, { shell: true, stdio: ['inherit', 'pipe', 'pipe'] })
  : spawn(cmd, args, { shell: false, stdio: ['inherit', 'pipe', 'pipe'] });

attachLineWatcher(child.stdout, process.stdout);
attachLineWatcher(child.stderr, process.stderr);

child.on('error', (err) => {
  console.error('🚫 启动子进程失败: ' + err.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  clearInterval(heartbeat);
  printSummary();
  outStream.end();
  process.exit(code === null ? 1 : code);
});

// 把 Ctrl+C 等信号转发给子进程，确保能正常退出
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => { try { child.kill(sig); } catch (e) {} });
});

// ============== 5. 按行检测逻辑 ==============
function attachLineWatcher(readable, writable) {
  let buffer = '';
  readable.setEncoding('utf8');
  readable.on('data', (chunk) => {
    writable.write(chunk); // 原样实时转发，终端体验不变
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      handleLine(line);
    }
  });
  readable.on('end', () => {
    if (buffer.trim()) handleLine(buffer);
  });
}

function handleLine(line) {
  totalLines++;
  if (!line.trim()) return;

  let matchedLevel = null;
  let matchedNames = [];
  for (const rule of RULES) {
    const hit = typeof rule.test === 'string'
      ? line.toLowerCase().indexOf(rule.test.toLowerCase()) !== -1
      : rule.test.test(line);
    if (hit) {
      matchedNames.push(rule.name);
      if (!matchedLevel || SEV_RANK[rule.level] > SEV_RANK[matchedLevel]) matchedLevel = rule.level;
    }
  }
  if (!matchedLevel) return;

  anomalyCounts[matchedLevel]++;
  const entry = {
    level: matchedLevel,
    time: Date.now(),
    message: line.trim(),
    rule: matchedNames.join(' / '),
  };
  outStream.write(JSON.stringify(entry) + '\n');

  const color = COLOR[matchedLevel] || '';
  process.stdout.write(color + '   ⚠ [已记录异常 · ' + matchedNames.join('/') + ']' + COLOR.reset + '\n');
}

function printSummary() {
  const total = anomalyCounts.fatal + anomalyCounts.error + anomalyCounts.warn;
  console.log('—'.repeat(50));
  console.log('📋 监测结束统计');
  console.log('   处理日志行数: ' + totalLines);
  console.log('   记录异常总数: ' + total + '  (FATAL ' + anomalyCounts.fatal + ' / ERROR ' + anomalyCounts.error + ' / WARN ' + anomalyCounts.warn + ')');
  console.log('   异常明细文件: ' + OUTPUT_FILE);
  console.log('—'.repeat(50));
}

// ============== 6. 心跳，证明监测器还活着（适合长时间跑的机器人）==============
let heartbeat = null;
if (HEARTBEAT_MS > 0) {
  heartbeat = setInterval(() => {
    const total = anomalyCounts.fatal + anomalyCounts.error + anomalyCounts.warn;
    console.log('\x1b[36m   💓 [监测器存活] 已处理 ' + totalLines + ' 行 · 已记录 ' + total + ' 条异常\x1b[0m');
  }, HEARTBEAT_MS);
}
