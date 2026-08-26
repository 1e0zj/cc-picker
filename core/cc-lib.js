'use strict';
// cc-lib.js — cc 系列 Node 脚本的共享库（providers 读写、路径、厂商配色）
// providers/*.json 与旧 PowerShell 版格式互通，老机器上的配置直接可用。

const fs = require('fs');
const path = require('path');
const os = require('os');

// CC_HOME 仅供测试/重定向（如沙箱安装验证）；正常取系统 home
const HOME = process.env.CC_HOME || os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const PROVIDERS_DIR = path.join(CLAUDE_DIR, 'providers');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const USAGE_CACHE = path.join(CLAUDE_DIR, 'cc-usage-cache.json');
const USAGE_LOCK = path.join(CLAUDE_DIR, 'cc-usage.last');

// 扫描 providers 目录（跳过 ".json" 之类的空名文件——历史遗留会在列表里变成无名幽灵行）
function listProviderFiles() {
  let files = [];
  try { files = fs.readdirSync(PROVIDERS_DIR); } catch { return []; }
  return files
    .filter(f => f.toLowerCase().endsWith('.json') && path.basename(f, '.json'))
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map(f => path.join(PROVIDERS_DIR, f));
}

// 右键菜单传来的路径要清洗：Windows 注册表的 %1/%V 在盘根目录展开成 "C:\"，
// 尾部反斜杠把结束引号吃掉，程序实际收到 C:" ——剥引号，裸盘符补回反斜杠
function normalizeDir(raw) {
  const d = String(raw || '').trim().replace(/^"+|"+$/g, '');
  return /^[A-Za-z]:$/.test(d) ? d + '\\' : d;
}

// 读文件文本并剥掉 UTF-8 BOM——旧 PowerShell 版写的 providers 全带 BOM，
// JSON.parse 不认 BOM 前缀，不剥的话 token 匹配 / 卡片 / 编辑回显全部失效
function readTextNoBom(file) {
  const s = fs.readFileSync(file, 'utf8');
  // 剥掉 UTF-8 BOM（U+FEFF）：JSON.parse 不认它做前缀
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

function readProviderEnv(file) {
  try {
    const j = JSON.parse(readTextNoBom(file));
    return (j && j.env && typeof j.env === 'object') ? j.env : null;
  } catch { return null; }
}

// 完整读出文件 JSON（含 env 之外的顶层键，供 JSON 编辑用）
function readProviderJson(file) {
  try {
    return JSON.parse(readTextNoBom(file));
  } catch { return null; }
}

function providerPath(name) { return path.join(PROVIDERS_DIR, name + '.json'); }

// 限额重置倒计时：>48h "6d18h"，>1h "2h31m"，<1h "37m"；已过期/太短返回空。
// 状态栏与 ccu 共用同一口径
function countdown(ms) {
  if (!(ms > 60000)) return '';
  const mins = Math.floor(ms / 60000);
  const h = Math.floor(mins / 60);
  if (h >= 48) { const d = Math.floor(h / 24); return `${d}d${h % 24}h`; }
  if (h > 0) return `${h}h${mins % 60}m`;
  return `${mins}m`;
}

// 对应 PS 版 Get-Providers：名称 / 地址 / token（含脱敏）/ 模型 / 完整 env
function getProviders() {
  return listProviderFiles().map(f => {
    const name = path.basename(f, '.json');
    const env = readProviderEnv(f) || {};
    const token = String(env.ANTHROPIC_AUTH_TOKEN || '');
    return {
      name,
      path: f,
      env,
      url: String(env.ANTHROPIC_BASE_URL || ''),
      token,
      masked: token.length > 10 ? token.slice(0, 6) + '...' + token.slice(-4)
             : (token || '(官方/空)'),
      model: String(env.ANTHROPIC_MODEL || ''),
    };
  });
}

// 保存：{ env: {...} }，UTF-8 无 BOM（旧 PowerShell 版读取同样兼容）
function saveProvider(name, env) {
  fs.mkdirSync(PROVIDERS_DIR, { recursive: true });
  const file = providerPath(name);
  fs.writeFileSync(file, JSON.stringify({ env }, null, 2) + '\n');
  return file;
}

// 厂商主色：与 wt tab / 状态栏配色一致（glm 系=青，deepseek 系=蓝，官方=绿，其余=黄）
function brandColor(p) {
  if (!p.url) return '#2ECC71';
  if (/^glm/i.test(p.name)) return '#00B8A9';
  if (/^deepseek/i.test(p.name)) return '#4D6FFF';
  return '#F1C40F';
}

// 全局 settings.json（解析失败/不存在返回 null）
function readSettings() {
  try {
    return JSON.parse(readTextNoBom(SETTINGS_FILE));
  } catch { return null; }
}

function writeSettings(obj) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2) + '\n');
}

module.exports = {
  HOME, CLAUDE_DIR, PROVIDERS_DIR, SETTINGS_FILE, USAGE_CACHE, USAGE_LOCK,
  readTextNoBom, listProviderFiles, readProviderEnv, readProviderJson, getProviders,
  providerPath, saveProvider, brandColor, readSettings, writeSettings, normalizeDir, countdown,
};
