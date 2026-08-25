#!/usr/bin/env node
'use strict';
// cc-picker — 安装 / 卸载 / 状态（npm bin；npx cc-picker install 同效）
//
// 用法:
//   cc-picker            安装（= install；npx 一次装的默认动作）
//   cc-picker install    部署核心脚本到 ~/.claude、写 shell 的 ccp/ccm 函数、配 statusLine、
//                        装文件管理器右键菜单（--no-menu 跳过这一项）
//   cc-picker update     拉最新 npm 包并刷新 ~/.claude 下的脚本（一步更新）
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
                    'cc-lib.js', 'cc-menu.js'];

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

  // 3. shell 的 ccp 命令（幂等：先移除旧标记块再追加）
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

  if (wantBash) {
    installRc(path.join(HOME, '.bashrc'));
    // 登录 shell 默认不读 .bashrc，这里手动加载
    const bp = path.join(HOME, '.bash_profile');
    if (!fs.existsSync(bp)) fs.writeFileSync(bp, '[ -f ~/.bashrc ] && . ~/.bashrc\n');
    say('[3/5] bash ccp 命令已装入 ~/.bashrc');
  }
  if (wantZsh) {
    installRc(path.join(HOME, '.zshrc'));
    say('[3/5] zsh ccp 命令已装入 ~/.zshrc');
  }
  if (!wantBash && !wantZsh) {
    say('[3/5] 未识别到 bash/zsh，跳过（请手动在 shell 配置里加 ccp/ccm 函数）');
  }

  // 4. settings.json 的 statusLine（已有则跳过，不动别家配置）
  let settings = readSettings();
  if (settings && settings.statusLine) {
    say('[4/5] settings.json 已有 statusLine，跳过');
  } else {
    if (!settings) settings = {};
    settings.statusLine = {
      type: 'command',
      // 正斜杠跨平台：node 在 Windows 也接受
      command: 'node ' + (CLAUDE_DIR + '/cc-statusline.js').replace(/\\/g, '/'),
    };
    writeSettings(settings);
    say('[4/5] settings.json 已加 statusLine');
  }

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
  for (const f of [...CORE_FILES, 'cc-usage-cache.json', 'cc-usage.last']) {
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
  say(`现在是 v${now}`);
  say('（statusLine、shell 函数、右键菜单指向的路径没变，不需要重装）');
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
  '      update 拉最新 npm 包并刷新 ~/.claude 下的脚本',
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
