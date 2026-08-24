'use strict';
// cc-lib.js — cc 系列 Node 脚本的共享库（providers 读写、路径、厂商配色）
// 与 Windows 版 cc-setup.ps1 的行为保持一致，providers/*.json 两端互通。

const fs = require('fs');
const path = require('path');
const os = require('os');

// CC_HOME 仅供测试/重定向（如沙箱安装验证）；正常取系统 home
const HOME = process.env.CC_HOME || os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const PROVIDERS_DIR = path.join(CLAUDE_DIR, 'providers');
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

function readProviderEnv(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (j && j.env && typeof j.env === 'object') ? j.env : null;
  } catch { return null; }
}

// 完整读出文件 JSON（含 env 之外的顶层键，供 JSON 编辑用）
function readProviderJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

function providerPath(name) { return path.join(PROVIDERS_DIR, name + '.json'); }

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

// 保存：{ env: {...} }，UTF-8 无 BOM（Windows 版 pwsh 读取同样兼容）
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

module.exports = {
  HOME, CLAUDE_DIR, PROVIDERS_DIR, USAGE_CACHE, USAGE_LOCK,
  listProviderFiles, readProviderEnv, readProviderJson, getProviders, providerPath, saveProvider, brandColor,
};
