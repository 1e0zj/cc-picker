#!/usr/bin/env node
'use strict';
// ccp.js — Claude Code 多供应商启动器（菜单/直达，当前终端原地启动）
//
// 用法:
//   ccp           交互菜单选择 provider 后在当前终端启动 claude
//   ccp <名称>    直接用 ~/.claude/providers/<名称>.json 启动（如 ccp glm）
//   ccp default   不带 --settings，走当前全局默认配置
//   ccp --dir <路径> [名称]   先切到该目录再启动（文件管理器右键菜单用，见 cc-menu.js）

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const lib = require('./cc-lib');

function findClaude() {
  // 常规情况 PATH 里有 claude，spawn 直接解析；这里只兜底原生安装位置
  const cands = [path.join(os.homedir(), '.local', 'bin',
    process.platform === 'win32' ? 'claude.exe' : 'claude')];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return 'claude';
}

function launch(args) {
  const claude = findClaude();
  // Windows 上 npm 装的是 claude.cmd，必须经 shell；unix 直接 spawn
  const child = process.platform === 'win32'
    ? spawn([claude, ...args].join(' '), { stdio: 'inherit', shell: true })
    : spawn(claude, args, { stdio: 'inherit' });
  child.on('error', err => {
    console.error(`ccp: 找不到 claude 可执行文件（PATH 和 ~\\.local\\bin 都没有）: ${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code == null ? 0 : code);
  });
}

(async () => {
  const argv = process.argv.slice(2);
  const di = argv.indexOf('--dir');
  if (di >= 0) {
    const dir = lib.normalizeDir(argv[di + 1]);
    argv.splice(di, 2);
    // 进不去就留在当前目录继续——比直接退出有用（右键窗口里还能自己 cd）
    try { process.chdir(dir); }
    catch (e) { console.error(`ccp: 无法进入目录 ${dir}（${e.message}），改在当前目录启动`); }
  }
  const pick = argv[0];

  if (pick) {
    if (pick === 'default') return launch([]);
    const f = lib.providerPath(pick);
    if (!fs.existsSync(f)) {
      console.error(`ccp: 配置不存在: ${f}`);
      process.exit(1);
    }
    return launch(['--settings', f]);
  }

  const files = lib.listProviderFiles();
  if (!files.length) {
    console.error(`ccp: 未找到 ${lib.PROVIDERS_DIR}/*.json`);
    process.exit(1);
  }
  console.log('\x1b[36m选择要使用的模型配置:\x1b[0m');
  console.log('  0) default（当前全局默认配置）');
  files.forEach((f, i) => console.log(`  ${i + 1}) ${path.basename(f, '.json')}`));

  process.stdout.write('输入编号 [1]: ');
  let line = '';
  for await (const chunk of process.stdin) { line = String(chunk).split(/\r?\n/)[0]; break; }
  let n = line.trim() || '1';
  if (n === '0') return launch([]);
  if (!/^\d+$/.test(n) || +n < 1 || +n > files.length) {
    console.error(`ccp: 无效选择: ${n}`);
    process.exit(1);
  }
  launch(['--settings', files[+n - 1]]);
})();
