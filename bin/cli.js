#!/usr/bin/env node
'use strict';
// cc-picker — 安装 / 卸载 / 状态（npm bin；npx cc-picker install 同效）
//
// 用法:
//   cc-picker            安装（= install；npx 一次装的默认动作）
//   cc-picker install    部署核心脚本到 ~/.claude、写 shell 的 ccp/ccm/ccu 函数、
//                        配 statusLine、装文件管理器右键菜单（--no-menu 跳过这一项）
//   cc-picker update     拉最新 npm 包、刷新 ~/.claude 下的脚本与 shell 函数块、
//                        迁移 PS 版旧安装（重写注册表菜单、换 statusLine、删 ps1 残留）
//   cc-picker uninstall  清理脚本/缓存/shell 函数/statusLine（providers 含 token，保留）
//   cc-picker status     查看安装状态
//   cc-picker menu ...   文件管理器右键菜单的装/卸（Windows / macOS，见 core/cc-menu.js）
//
// 设计：运行时部署在 ~/.claude（稳定路径，nvm 切版本/卸包不影响）；
// npm 全局 bin 的 ccp/ccm 与 profile 函数等价，二者都可用。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const PKG_ROOT = path.join(__dirname, '..');
const PKG_VERSION = require('../package.json').version;
const CORE_DIR = path.join(PKG_ROOT, 'core');
const HOME = process.env.CC_HOME || os.homedir();   // CC_HOME 仅供测试/沙箱
const CLAUDE_DIR = path.join(HOME, '.claude');
const PROVIDERS_DIR = path.join(CLAUDE_DIR, 'providers');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');

const CORE_FILES = ['ccp.js', 'ccm.js', 'ccm-page.html', 'cc-statusline.js', 'cc-usage.js',
                    'cc-lib.js', 'cc-menu.js', 'ccu.js'];

// 已下线的 PowerShell 版部署在 ~/.claude 的脚本（cc-setup.ps1 时代装的）——update 清掉
const PS_FILES = ['cc-launch.ps1', 'cc-manager.ps1', 'cc-statusline.ps1', 'cc-usage.ps1'];

// 右键菜单只有 Windows / macOS 有实现（Linux 各文件管理器机制不同）
const MENU_PLATFORM = process.platform === 'win32' || process.platform === 'darwin';
const menuModule = () => require(path.join(CORE_DIR, 'cc-menu.js'));

const MARK_BEGIN = '# >>> cc 多供应商启动器 >>>';
const MARK_END = '# <<< cc 多供应商启动器 <<<';
const CC_BLOCK = `
${MARK_BEGIN}
# ccp           交互菜单选择 provider 后在当前终端启动 claude
# ccp <名称>    直接用 ~/.claude/providers/<名称>.json 启动（如 ccp glm）
# ccp default   不带 --settings，走当前全局默认配置
ccp() { node "$HOME/.claude/ccp.js" "$@"; }
# ccm — 打开供应商配置管理器（Web UI）
ccm() { node "$HOME/.claude/ccm.js" "$@"; }
# ccu [名称…] — 命令行速览限额/余额与重置倒计时（缺省全部）
ccu() { node "$HOME/.claude/ccu.js" "$@"; }
${MARK_END}`;

const TEMPLATES = {
  'official.json': `{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "",
    "ANTHROPIC_BASE_URL": "",
    "ANTHROPIC_MODEL": "",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME": "",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "",
    "API_TIMEOUT_MS": ""
  }
}
`,
  'glm.json': `{
  "env": {
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "在这里填入你的GLM_APIKey",
    "ANTHROPIC_MODEL": "glm-5.3[1M]",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "glm-5.3[1M]",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME": "glm-5.3",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-5.3",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "glm-5.3",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.3[1M]",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "glm-5.3",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.3[1M]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "glm-5.3",
    "API_TIMEOUT_MS": "3000000"
  }
}
`,
};

const say = s => console.log(s);
const L = (...lines) => lines.join('\n');
const hdr = s => console.log('\x1b[36m' + s + '\x1b[0m');

function stripBlock(text) {
  const re = new RegExp(MARK_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    + '[\\s\\S]*?' + MARK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n?', 'g');
  return text.replace(re, '');
}

function readSettings() {
  try {
    const s = fs.readFileSync(SETTINGS_FILE, 'utf8');
    // 剥 UTF-8 BOM（JSON.parse 不认它做前缀）
    return JSON.parse(s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s);
  } catch { return null; }
}
function writeSettings(obj) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2) + '\n');
}

// statusLine 三种情况：没有 → 配上；指向本项目已下线的 PS 版（cc-statusline.ps1）→
// 换成 Node 版；用户自己的 → 不动。install 与 update 共用。
function ensureStatusline() {
  let settings = readSettings();
  const cmd = settings && settings.statusLine && String(settings.statusLine.command || '');
  // 正斜杠跨平台：node 在 Windows 也接受
  const nodeCmd = 'node ' + (CLAUDE_DIR + '/cc-statusline.js').replace(/\\/g, '/');
  if (cmd === nodeCmd) return '已是 Node 版，跳过';
  if (!cmd) {
    if (!settings) settings = {};
    settings.statusLine = { type: 'command', command: nodeCmd };
    writeSettings(settings);
    return '已加 statusLine';
  }
  if (cmd.includes('cc-statusline.ps1')) {
    settings.statusLine = { type: 'command', command: nodeCmd };
    writeSettings(settings);
    return 'PS 版 statusLine 已替换为 Node 版';
  }
  return '已有 statusLine，跳过';
}

// shell 的 ccp/ccm/ccu 函数（幂等：先移除旧标记块再追加）——install 与 update 共用，
// 函数块内容完全由包版本决定，update 重写一遍才能带上新增命令
function ensureShellFunctions() {
  const installRc = rc => {
    const existing = fs.existsSync(rc) ? fs.readFileSync(rc, 'utf8') : '';
    fs.writeFileSync(rc, stripBlock(existing).replace(/\s+$/, '') + '\n' + CC_BLOCK + '\n');
  };
  let wantBash = fs.existsSync(path.join(HOME, '.bashrc'));
  let wantZsh = fs.existsSync(path.join(HOME, '.zshrc'));
  const shell = process.env.SHELL || '';
  // 包含匹配而非结尾匹配：Git Bash 的 SHELL 是 /bin/bash.exe（带 .exe）
  if (/bash/.test(shell)) wantBash = true;
  if (/zsh/.test(shell)) wantZsh = true;
  const wrote = [];
  if (wantBash) {
    installRc(path.join(HOME, '.bashrc'));
    // 登录 shell 默认不读 .bashrc，这里手动加载
    const bp = path.join(HOME, '.bash_profile');
    if (!fs.existsSync(bp)) fs.writeFileSync(bp, '[ -f ~/.bashrc ] && . ~/.bashrc\n');
    wrote.push('bash');
  }
  if (wantZsh) { installRc(path.join(HOME, '.zshrc')); wrote.push('zsh'); }
  return wrote;
}

// ---------- install ----------

function install(noMenu, isUpdate) {
  hdr(`== Claude Code 多供应商启动器 ${isUpdate ? '更新' : '安装'} v${PKG_VERSION} ==`);

  try { fs.mkdirSync(PROVIDERS_DIR, { recursive: true }); } catch {}

  // 1. 核心脚本
  for (const f of CORE_FILES) {
    fs.copyFileSync(path.join(CORE_DIR, f), path.join(CLAUDE_DIR, f));
  }
  say('[1/5] ccp.js / ccm.js / cc-statusline.js / cc-usage.js 已写入 ~/.claude/');

  // 2. providers 模板（已存在的不覆盖）
  for (const [name, body] of Object.entries(TEMPLATES)) {
    const p = path.join(PROVIDERS_DIR, name);
    if (fs.existsSync(p)) { say(`      providers/${name} 已存在，跳过`); }
    else { fs.writeFileSync(p, body); say(`      providers/${name} 模板已创建`); }
  }
  say('[2/5] providers 目录就绪');

  // 3. shell 的 ccp/ccm/ccu 函数（幂等重写标记块）
  const wrote = ensureShellFunctions();
  if (wrote.includes('bash')) say('[3/5] bash 的 ccp/ccm/ccu 函数已装入 ~/.bashrc');
  if (wrote.includes('zsh')) say('[3/5] zsh 的 ccp/ccm/ccu 函数已装入 ~/.zshrc');
  if (!wrote.length) {
    say('[3/5] 未识别到 bash/zsh，跳过（请手动在 shell 配置里加 ccp/ccm/ccu 函数）');
  }

  // 4. settings.json 的 statusLine（用户自己的配置不动，见 ensureStatusline）
  say(`[4/5] settings.json ${ensureStatusline()}`);

  // 5. 文件管理器右键菜单（默认装——改注册表 / 写 ~/Library/Services，--no-menu 可跳过）
  if (!MENU_PLATFORM) {
    say('[5/5] 当前平台没有右键菜单实现，跳过');
  } else if (noMenu) {
    say('[5/5] --no-menu：跳过右键菜单（以后想要: cc-picker menu install）');
  } else {
    process.stdout.write('[5/5] ');   // 跟 cc-menu 自己那句成功提示拼成一行
    try { menuModule().menuInstall(); }
    catch (e) { say('右键菜单安装失败（不影响其他部分）: ' + e.message); }
  }

  say('');
  say('安装完成。后续步骤：');
  say('  1. 运行 ccm 打开供应商管理器（浏览器页面），新增/编辑配置（或从旧机器拷贝 providers/*.json）');
  say('  2. 新开终端即可用 ccp / ccp glm 等（npm 全局装的用户 ccp/ccm 命令直接可用）');
  if (MENU_PLATFORM && !noMenu) {
    say('  3. 右键任意文件夹 →「Claude Code（选模型）」也能启动；不想要的话 cc-picker menu uninstall');
  }
  if (fs.existsSync(path.join(HOME, '.cc-switch'))) {
    say('  注意：检测到 cc-switch——它会整份重写 settings.json，请把 statusLine 段加进它的 "Claude 通用配置"，否则切换供应商后状态栏会消失');
  }
}

// ---------- uninstall ----------

function uninstall() {
  hdr('== Claude Code 多供应商启动器 卸载 ==');
  // 1. shell 配置里的标记块
  for (const name of ['.bashrc', '.zshrc']) {
    const rc = path.join(HOME, name);
    if (fs.existsSync(rc)) {
      fs.writeFileSync(rc, stripBlock(fs.readFileSync(rc, 'utf8')));
      say(`已清理 ${rc}`);
    }
  }
  // 2. 右键菜单（没装也不报错）
  if (MENU_PLATFORM) {
    try { menuModule().menuUninstall(); } catch {}
  }
  // 3. 脚本与缓存（providers 保留：内含 token）
  for (const f of [...CORE_FILES, ...PS_FILES, 'cc-usage-cache.json', 'cc-usage.last']) {
    const p = path.join(CLAUDE_DIR, f);
    try { fs.unlinkSync(p); } catch {}
  }
  say('已删除 ~/.claude/ 下的 cc 系列脚本与缓存');
  // 4. settings.json 里删掉本项目写入的 statusLine（仅当它指向 cc-statusline）
  const settings = readSettings();
  if (settings && settings.statusLine
      && String(settings.statusLine.command || '').includes('cc-statusline')) {
    delete settings.statusLine;
    writeSettings(settings);
    say('settings.json 已移除 statusLine');
  }
  say('卸载完成（providers/*.json 保留，如需删除: rm -rf ~/.claude/providers）');
}

// ~/.claude 下的是安装时复制的副本——npm 升级包不会自动刷新它们，
// 逐文件比内容就知道要不要重跑一次 install
function staleFiles() {
  return CORE_FILES.filter(f => {
    try {
      return fs.readFileSync(path.join(CORE_DIR, f), 'utf8')
        !== fs.readFileSync(path.join(CLAUDE_DIR, f), 'utf8');
    } catch { return true; }
  });
}

// ---------- update ----------

// npm 换包只换 node_modules 里的源文件，~/.claude 下的副本得另刷一遍。
// 新包的 postinstall 通常已经代劳，这里再核一次，兜住它没跑起来的情况。
function update() {
  hdr('== cc-picker 更新 ==');
  if (!/node_modules/.test(PKG_ROOT)) {
    say('当前跑的不是 npm 装的包（看着像克隆的仓库）——更新请用: git pull && bash install.sh');
    return;
  }
  say(`当前 v${PKG_VERSION}，正在拉取最新版…`);
  // 整条命令给字符串而不是 args 数组：Windows 上 npm 是 .cmd，必须经 shell 才跑得起来，
  // 而 shell:true 配 args 数组会触发 Node 的 DEP0190 弃用警告（命令这里是硬编码的）
  const r = spawnSync('npm install -g cc-picker@latest', { stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    say('npm 安装没成功——手动跑一次: npm install -g cc-picker@latest');
    process.exitCode = 1;
    return;
  }
  // 包已被换成新版，重新读一遍版本号（PKG_VERSION 是进程启动时的旧值）
  let now = PKG_VERSION;
  try { now = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version; } catch {}
  const stale = staleFiles();
  for (const f of stale) {
    try { fs.copyFileSync(path.join(CORE_DIR, f), path.join(CLAUDE_DIR, f)); } catch {}
  }
  say(stale.length ? `~/.claude 下 ${stale.length} 个脚本已刷新` : '~/.claude 下的脚本已是最新');

  // shell 函数块随包版本走（新增命令如 ccu 靠这步进入 shell）
  const wrote = ensureShellFunctions();
  if (wrote.length) say(`      shell 函数块已刷新（${wrote.join('/')}）`);

  // PS 版升上来的机器还带着三样旧东西，这里一并迁移：
  //   注册表菜单指向 cc-launch.ps1、statusLine 跑 cc-statusline.ps1、~/.claude 下的 ps1 脚本
  if (MENU_PLATFORM) {
    try {
      const m = menuModule();
      if (m.menuInstalled()) {
        process.stdout.write('      ');   // 跟 menuInstall 自己那句成功提示拼成一行
        m.menuInstall();
      }
    } catch (e) { say('右键菜单刷新失败（不影响其他部分）: ' + e.message); }
  }
  say(`      settings.json ${ensureStatusline()}`);
  const gone = PS_FILES.filter(f => {
    try { fs.unlinkSync(path.join(CLAUDE_DIR, f)); return true; } catch { return false; }
  });
  if (gone.length) say(`      已删除 PS 版残留: ${gone.join(', ')}`);

  say(`现在是 v${now}`);
}

// ---------- status ----------

function status() {
  hdr('== cc-picker 安装状态 ==');
  const missing = CORE_FILES.filter(f => !fs.existsSync(path.join(CLAUDE_DIR, f)));
  say(`核心脚本: ${missing.length ? '缺失 ' + missing.join(', ') : '齐全（~/.claude/）'}`);
  const stale = staleFiles().filter(f => !missing.includes(f));
  if (stale.length) {
    say(`          ${stale.join(", ")} 与当前包 v${PKG_VERSION} 不一致——跑 cc-picker update 刷新`);
  } else if (!missing.length) {
    say(`          与当前包 v${PKG_VERSION} 一致`);
  }
  const s = readSettings();
  const sl = s && s.statusLine && String(s.statusLine.command || '');
  say(`statusLine: ${sl ? sl : '未配置'}`);
  if (sl.includes('cc-statusline.ps1')) say('          还是 PS 版——跑 cc-picker update 换成 Node 版');
  const psLeft = PS_FILES.filter(f => fs.existsSync(path.join(CLAUDE_DIR, f)));
  if (psLeft.length) say(`PS 残留:   ${psLeft.join(', ')}（跑 cc-picker update 清理）`);
  for (const name of ['.bashrc', '.zshrc']) {
    const rc = path.join(HOME, name);
    if (fs.existsSync(rc)) {
      say(`${name}: ${fs.readFileSync(rc, 'utf8').includes(MARK_BEGIN) ? '含 ccp 函数块' : '无'}`);
    }
  }
  let n = 0;
  try { n = fs.readdirSync(PROVIDERS_DIR).filter(f => f.endsWith('.json')).length; } catch {}
  say(`providers: ${n} 个配置（${PROVIDERS_DIR}）`);
  if (MENU_PLATFORM) {
    say('右键菜单:');
    try { menuModule().menuStatus(); } catch (e) { say('  查询失败: ' + e.message); }
  }
}

// ---------- 入口 ----------

const USAGE = L(
  '用法: cc-picker [install|update|uninstall|status] [--no-menu]   # 缺省 install',
  '      update 拉最新 npm 包、刷新 ~/.claude 脚本与 shell 函数块、迁移 PS 版旧安装',
  '      --no-menu 只在 install 时有意义：跳过文件管理器右键菜单',
  '      cc-picker menu [install|uninstall|status]  # 文件管理器右键菜单（Windows / macOS）');

// 供 postinstall.js 复用；下面的入口只在直接执行时跑
module.exports = { CORE_FILES };
if (require.main !== module) return;

const cmd = process.argv[2] || 'install';
const noMenu = process.argv.includes('--no-menu');
switch (cmd) {
  case 'install': install(noMenu); break;
  case 'update': update(); break;
  case 'uninstall': uninstall(); break;
  case 'status': status(); break;
  case 'menu': {
    if (!MENU_PLATFORM) {
      say('右键菜单只支持 Windows 与 macOS——Linux 各文件管理器机制不同，直接用 ccp 即可');
      process.exit(1);
    }
    const m = menuModule();
    const sub = process.argv[3] || 'install';
    if (sub === 'install') m.menuInstall();
    else if (sub === 'uninstall') m.menuUninstall();
    else if (sub === 'status') m.menuStatus();
    else {
      say(`未知子命令: ${sub}\n用法: cc-picker menu [install|uninstall|status]`);
      process.exit(1);
    }
    break;
  }
  case 'help': case '--help': case '-h':
    say(USAGE);
    break;
  default:
    say(`未知命令: ${cmd}\n` + USAGE);
    process.exit(1);
}
