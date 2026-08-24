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

// 保存：保留原 env 其余键，仅覆盖表单里的键；_NAME 变体去掉 [1M] 之类的档位后缀
function saveFromForm(body) {
  const name = String(body.name || '').trim();
  const oldName = body.oldName ? String(body.oldName) : null;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return { error: '名称只能用英文、数字、-、_（方便命令行 cc <名称> 使用）' };
  }
  if (name !== oldName && fs.existsSync(lib.providerPath(name))) {
    return { error: `已存在同名配置: ${name}` };
  }

  const env = { ...(body.rawEnv || {}) };
  const strip = v => String(v || '').trim().replace(/\[.*$/, '');
  const trim = v => String(v || '').trim();
  env.ANTHROPIC_BASE_URL                  = trim(body.url);
  env.ANTHROPIC_AUTH_TOKEN                = trim(body.token);
  env.ANTHROPIC_MODEL                     = trim(body.model);
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL       = trim(body.haiku);
  env.ANTHROPIC_DEFAULT_OPUS_MODEL        = trim(body.opus);
  env.ANTHROPIC_DEFAULT_SONNET_MODEL      = trim(body.sonnet);
  env.ANTHROPIC_DEFAULT_FABLE_MODEL       = trim(body.fable);
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME  = strip(body.haiku);
  env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME   = strip(body.opus);
  env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = strip(body.sonnet);
  env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME  = strip(body.fable);
  env.API_TIMEOUT_MS                      = trim(body.timeout);

  // 改名 = 删旧文件，再按新名写入
  if (oldName && oldName !== name) {
    try { fs.unlinkSync(lib.providerPath(oldName)); } catch {}
  }
  lib.saveProvider(name, env);
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
      const providers = lib.getProviders().map(p => ({
        name: p.name, url: p.url, model: p.model, masked: p.masked, env: p.env,
      }));
      return sendJson(res, 200, { providers, dir: lib.PROVIDERS_DIR });
    }

    if (req.method === 'POST' && url.pathname === '/api/save') {
      const r = saveFromForm(await readBody(req));
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
