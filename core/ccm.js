#!/usr/bin/env node
'use strict';
// ccm.js — Claude Code 供应商配置管理器（providers/*.json 的 Web UI）
//
// 用法:
//   ccm                  起本地 HTTP 服务并自动打开浏览器
//   ccm --list           控制台列出全部配置（无 UI，供脚本/测试用）
//   ccm --no-browser     起服务但不自动开浏览器
//
// 只监听 127.0.0.1，页面与 API 均不对外；API 仅接受本机 Host 头（防 DNS rebinding）。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const lib = require('./cc-lib');

const args = process.argv.slice(2);
if (args.includes('--list')) {
  const ps = lib.getProviders();
  if (!ps.length) { console.log(`（${lib.PROVIDERS_DIR} 下没有配置）`); process.exit(0); }
  for (const p of ps) {
    console.log(`${p.name.padEnd(16)} ${p.url.padEnd(45)} ${p.masked.padEnd(14)} ${p.model}`);
  }
  process.exit(0);
}
const noBrowser = args.includes('--no-browser');

// ---------- 数据操作（与 Windows 版 cc-manager.ps1 行为一致） ----------

// 保存（cc-switch 式 JSON 编辑）：text 为文件完整内容，服务端校验后原样落盘。
// 允许 env 之外的顶层键（provider 文件本质是 --settings 层，可带其他配置）。
function saveRaw(body) {
  const name = String(body.name || '').trim();
  const oldName = body.oldName ? String(body.oldName) : null;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return { error: '名称只能用英文、数字、-、_（方便命令行 cc <名称> 使用）' };
  }
  if (name !== oldName && fs.existsSync(lib.providerPath(name))) {
    return { error: `已存在同名配置: ${name}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(String(body.text || ''));
  } catch (e) {
    return { error: `JSON 解析失败：${e.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || !parsed.env || typeof parsed.env !== 'object' || Array.isArray(parsed.env)) {
    return { error: 'JSON 结构应为 { "env": { ... } }' };
  }

  // 改名 = 删旧文件，再按新名写入
  if (oldName && oldName !== name) {
    try { fs.unlinkSync(lib.providerPath(oldName)); } catch {}
  }
  fs.mkdirSync(lib.PROVIDERS_DIR, { recursive: true });
  fs.writeFileSync(lib.providerPath(name), JSON.stringify(parsed, null, 2) + '\n');
  return { ok: true };
}

// 连通测试：对 {BASE_URL}/v1/messages 发一条 max_tokens=1 的最小请求；
// 能拿到任何 HTTP 状态（含 401/400）即说明网络与端点通，附上错误摘要
async function testProvider(p) {
  const url = (p.url || '').trim() || 'https://api.anthropic.com';
  const body = JSON.stringify({ model: p.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
  try {
    const resp = await fetch(url.replace(/\/+$/, '') + '/v1/messages', {
      method: 'POST',
      headers: {
        'anthropic-version': '2023-06-01',
        'x-api-key': p.token,
        'authorization': 'Bearer ' + p.token,
        'content-type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(20000),
    });
    let detail = '';
    try { detail = (await resp.json())?.error?.message || ''; } catch {}
    if (resp.ok) return `HTTP ${resp.status} OK — 端点与鉴权均正常`;
    return `HTTP ${resp.status} — 端点可达${detail ? `（${detail}）` : ''}`;
  } catch (e) {
    return `不可达：${(e && e.message) || e}`;
  }
}

function openPath(dir) {
  try {
    if (process.platform === 'win32') {
      spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {}
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {}
}

// 当前默认供应商：按全局 settings.json 的 env 匹配（token 优先，其次 BASE_URL；
// 都空 = 官方）。匹配不到供应商时返回主机名，供页脚显示
function currentDefault(provs) {
  const env = (lib.readSettings() || {}).env || {};
  const tok = String(env.ANTHROPIC_AUTH_TOKEN || '');
  const url = String(env.ANTHROPIC_BASE_URL || '');
  if (tok) {
    const m = provs.find(p => p.token && p.token === tok);
    if (m) return m.name;
  }
  if (url) {
    const m = provs.find(p => p.url && p.url === url);
    if (m) return m.name;
    return url.replace(/^https?:\/\//, '').split('/')[0];
  }
  return 'official';
}

// 设为默认：把供应商 env 合入全局 settings.json（statusLine 等其他顶层键原样保留）。
// 合并语义——通用配置（settings.json env 里手写的键）不被覆盖：
//   非空值 = 覆盖/写入；空值 = 清除该键；未提及的键 = 保留原值。
// 官方模板全部为空值 → 点它即清掉所有供应商键，回到官方。可替代 cc-switch 的切换功能。
function setDefault(name) {
  const sel = lib.getProviders().find(p => p.name === name);
  if (!sel) return { error: `配置不存在: ${name}` };

  const settings = lib.readSettings() || {};
  const env = { ...(settings.env || {}) };   // 以现有 env 为底
  for (const [k, v] of Object.entries(sel.env)) {
    const s = String(v == null ? '' : v).trim();
    if (s === '') delete env[k];
    else env[k] = s;
  }
  if (Object.keys(env).length) settings.env = env;
  else delete settings.env;
  lib.writeSettings(settings);
  return { ok: true };
}

// ---------- HTTP ----------

const PAGE = path.join(__dirname, 'ccm-page.html');

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    // 防跨站读取：仅接受本机 Host（浏览器里远程页面发起的 fetch 带不来这个 Host）
    const host = (req.headers.host || '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') {
      return sendJson(res, 403, { error: 'forbidden host' });
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(PAGE));
    }

    if (req.method === 'GET' && url.pathname === '/api/providers') {
      const base = lib.getProviders();
      const defName = currentDefault(base);
      const providers = base.map(p => ({
        name: p.name, url: p.url, model: p.model, masked: p.masked, env: p.env,
        raw: lib.readProviderJson(p.path),
        isDefault: p.name === defName,
      }));
      return sendJson(res, 200, { providers, dir: lib.PROVIDERS_DIR, defaultName: defName });
    }

    if (req.method === 'POST' && url.pathname === '/api/save') {
      const r = saveRaw(await readBody(req));
      return sendJson(res, r.error ? 400 : 200, r);
    }

    // 通用配置：查看/编辑全局 settings.json
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      const raw = fs.existsSync(lib.SETTINGS_FILE) ? lib.readTextNoBom(lib.SETTINGS_FILE) : '{}';
      let text;
      try { text = JSON.stringify(JSON.parse(raw), null, 2); } catch { text = raw; }
      return sendJson(res, 200, { text, path: lib.SETTINGS_FILE });
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const { text } = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(String(text || '')); }
      catch (e) { return sendJson(res, 400, { error: `JSON 解析失败：${e.message}` }); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return sendJson(res, 400, { error: 'settings.json 应为 JSON 对象' });
      }
      lib.writeSettings(parsed);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/set-default') {
      const r = setDefault((await readBody(req)).name);
      return sendJson(res, r.error ? 400 : 200, r);
    }

    if (req.method === 'POST' && url.pathname === '/api/delete') {
      const { name } = await readBody(req);
      if (!name) return sendJson(res, 400, { error: 'missing name' });
      try { fs.unlinkSync(lib.providerPath(String(name))); } catch {}
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/test') {
      const { name } = await readBody(req);
      const sel = lib.getProviders().find(p => p.name === name);
      if (!sel) return sendJson(res, 404, { error: 'no such provider' });
      const msg = await testProvider(sel);
      return sendJson(res, 200, { msg });
    }

    if (req.method === 'POST' && url.pathname === '/api/open-folder') {
      fs.mkdirSync(lib.PROVIDERS_DIR, { recursive: true });
      openPath(lib.PROVIDERS_DIR);
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 500, { error: String((e && e.message) || e) });
  }
}

const server = http.createServer(handler);
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  console.log(`ccm 管理器已启动: ${url}  （Ctrl+C 退出）`);
  if (!noBrowser) openBrowser(url);
});
