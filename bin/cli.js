#!/usr/bin/env node
'use strict';
// cc-picker — 安装 / 卸载 / 状态（npm bin；npx cc-picker install 同效）
//
// 用法:
//   cc-picker            安装（= install；npx 一次装的默认动作）
//   cc-picker install    部署核心脚本到 ~/.claude、写 shell 的 ccp/ccm 函数、配 statusLine
//   cc-picker uninstall  清理脚本/缓存/shell 函数/statusLine（providers 含 token，保留）
//   cc-picker status     查看安装状态
//
// 设计：运行时部署在 ~/.claude（稳定路径，nvm 切版本/卸包不影响）；
// npm 全局 bin 的 ccp/ccm 与 profile 函数等价，二者都可用。

const fs = require('fs');
const path = require('path');
const os = require('os');

const PKG_ROOT = path.join(__dirname, '..');
const CORE_DIR = path.join(PKG_ROOT, 'core');
const HOME = process.env.CC_HOME || os.homedir();   // CC_HOME 仅供测试/沙箱
const CLAUDE_DIR = path.join(HOME, '.claude');
const PROVIDERS_DIR = path.join(CLAUDE_DIR, 'providers');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');

const CORE_FILES = ['ccp.js', 'ccm.js', 'ccm-page.html', 'cc-statusline.js', 'cc-usage.js', 'cc-lib.js'];

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

function install() {
  hdr('== Claude Code 多供应商启动器 安装 ==');

  try { fs.mkdirSync(PROVIDERS_DIR, { recursive: true }); } catch {}

  // 1. 核心脚本
  for (const f of CORE_FILES) {
    fs.copyFileSync(path.join(CORE_DIR, f), path.join(CLAUDE_DIR, f));
  }
  say('[1/4] ccp.js / ccm.js / cc-statusline.js / cc-usage.js 已写入 ~/.claude/');

  // 2. providers 模板（已存在的不覆盖）
  for (const [name, body] of Object.entries(TEMPLATES)) {
    const p = path.join(PROVIDERS_DIR, name);
    if (fs.existsSync(p)) { say(`      providers/${name} 已存在，跳过`); }
    else { fs.writeFileSync(p, body); say(`      providers/${name} 模板已创建`); }
  }
  say('[2/4] providers 目录就绪');

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
    say('[3/4] bash ccp 命令已装入 ~/.bashrc');
  }
  if (wantZsh) {
    installRc(path.join(HOME, '.zshrc'));
    say('[3/4] zsh ccp 命令已装入 ~/.zshrc');
  }
  if (!wantBash && !wantZsh) {
    say('[3/4] 未识别到 bash/zsh，跳过（请手动在 shell 配置里加 ccp/ccm 函数）');
  }

  // 4. settings.json 的 statusLine（已有则跳过，不动别家配置）
  let settings = readSettings();
  if (settings && settings.statusLine) {
    say('[4/4] settings.json 已有 statusLine，跳过');
  } else {
    if (!settings) settings = {};
    settings.statusLine = {
      type: 'command',
      // 正斜杠跨平台：node 在 Windows 也接受
      command: 'node ' + (CLAUDE_DIR + '/cc-statusline.js').replace(/\\/g, '/'),
    };
    writeSettings(settings);
    say('[4/4] settings.json 已加 statusLine');
  }

  say('');
  say('安装完成。后续步骤：');
  say('  1. 运行 ccm 打开供应商管理器（浏览器页面），新增/编辑配置（或从旧机器拷贝 providers/*.json）');
  say('  2. 新开终端即可用 ccp / ccp glm 等（npm 全局装的用户 ccp/ccm 命令直接可用）');
  if (fs.existsSync(path.join(HOME, '.cc-switch'))) {
    say('  3. 注意：检测到 cc-switch——它会整份重写 settings.json，请把 statusLine 段加进它的 "Claude 通用配置"，否则切换供应商后状态栏会消失');
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
  // 2. 脚本与缓存（providers 保留：内含 token）
  for (const f of [...CORE_FILES, 'cc-usage-cache.json', 'cc-usage.last']) {
    const p = path.join(CLAUDE_DIR, f);
    try { fs.unlinkSync(p); } catch {}
  }
  say('已删除 ~/.claude/ 下的 cc 系列脚本与缓存');
  // 3. settings.json 里删掉本项目写入的 statusLine（仅当它指向 cc-statusline）
  const settings = readSettings();
  if (settings && settings.statusLine
      && String(settings.statusLine.command || '').includes('cc-statusline')) {
    delete settings.statusLine;
    writeSettings(settings);
    say('settings.json 已移除 statusLine');
  }
  say('卸载完成（providers/*.json 保留，如需删除: rm -rf ~/.claude/providers）');
}

// ---------- status ----------

function status() {
  hdr('== cc-picker 安装状态 ==');
  const missing = CORE_FILES.filter(f => !fs.existsSync(path.join(CLAUDE_DIR, f)));
  say(`核心脚本: ${missing.length ? '缺失 ' + missing.join(', ') : '齐全（~/.claude/）'}`);
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
}

// ---------- 入口 ----------

const cmd = process.argv[2] || 'install';
switch (cmd) {
  case 'install': install(); break;
  case 'uninstall': uninstall(); break;
  case 'status': status(); break;
  case 'help': case '--help': case '-h':
    say('用法: cc-picker [install|uninstall|status]   # 缺省 install');
    break;
  default:
    say(`未知命令: ${cmd}\n用法: cc-picker [install|uninstall|status]`);
    process.exit(1);
}
