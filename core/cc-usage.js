#!/usr/bin/env node
'use strict';
// cc-usage.js — 供应商限额/余额查询（结果写缓存，供状态栏显示；由状态栏异步调起）
//
// 数据源（按 ANTHROPIC_BASE_URL 识别）：
//   GLM 套餐（bigmodel.cn / z.ai）   GET {host}/api/monitor/usage/quota/limit（Authorization 用裸 token，不加 Bearer）
//                                     data.limits[] 里 type=TOKENS_LIMIT/CREDIT_LIMIT 的条目：unit=3 → 5小时窗口，unit=6 → 周窗口
//   DeepSeek                          GET https://api.deepseek.com/user/balance（账户余额，CNY）
//   Claude 官方订阅                  GET https://api.anthropic.com/api/oauth/usage
//                                     （复用 Claude Code 的本机 OAuth 登录，不读取/上传到其他服务）
//   其他                              不查询
//
// 用法: node cc-usage.js [provider 名 ...]    # 缺省刷新全部
// 缓存: ~/.claude/cc-usage-cache.json   （格式 { <名>: { fetchedAt, tiers:[{kind,pct,resetMs}] | balance | error } } ）

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./cc-lib');

function usageKind(p) {
  if (/bigmodel\.cn|api\.z\.ai/.test(p.url)) return 'quota';
  if (/api\.deepseek\.com/.test(p.url)) return 'balance';
  // 空 URL + 空 Token 才是 Claude Code 登录态；直连 Anthropic API Key 不属于订阅额度。
  if (!p.url.trim() && !p.token.trim()) return 'subscription';
  return '';
}

function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(lib.USAGE_CACHE, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

function writeCache(cacheMap) {
  const out = {};
  for (const k of Object.keys(cacheMap).sort()) out[k] = cacheMap[k];
  try {
    fs.mkdirSync(lib.CLAUDE_DIR, { recursive: true });
    fs.writeFileSync(lib.USAGE_CACHE, JSON.stringify(out, null, 2));
  } catch {}
}

function clearUsage(name) {
  const cacheMap = readCache();
  delete cacheMap[name];
  writeCache(cacheMap);
}

async function glmUsage(apiHost, token, now) {
  try {
    const resp = await fetch(apiHost + '/api/monitor/usage/quota/limit', {
      headers: { Authorization: token },
      signal: AbortSignal.timeout(15000),
    });
    const j = await resp.json().catch(() => null);
    if (!j || !j.success || !j.data) {
      return { fetchedAt: now, error: 'API: ' + ((j && j.msg) || 'HTTP ' + resp.status) };
    }
    const items = [];
    for (const lim of (j.data.limits || [])) {
      // 只解析 TOKENS_LIMIT/CREDIT_LIMIT（5h 与周窗口）；TIME_LIMIT 是附加产品
      // （搜索/网页阅读等）的月度量，不是模型调用限额，不显示
      if (!['TOKENS_LIMIT', 'CREDIT_LIMIT'].includes(String(lim.type))) continue;
      // unit 分类；缺失时兜底：无 nextResetTime 的归 5h（周期耗尽态可能无重置时间），其余归周
      const unit = Number(lim.unit);
      let kind;
      if (unit === 3) kind = 'h5';
      else if (unit === 6) kind = 'week';
      else if (!lim.nextResetTime) kind = 'h5';
      else kind = 'week';
      // nextResetTime：毫秒时间戳（周期耗尽态可能缺失），保存供状态栏算重置倒计时
      const resetMs = lim.nextResetTime ? (Math.round(Number(lim.nextResetTime)) || 0) : 0;
      items.push({ kind, pct: Math.trunc(Number(lim.percentage) || 0), resetMs });
    }
    const tiers = [];
    for (const k of ['h5', 'week']) {
      const t = items.find(i => i.kind === k);
      if (t) tiers.push(t);
    }
    return { fetchedAt: now, tiers };
  } catch (e) {
    return { fetchedAt: now, error: String((e && e.message) || e) };
  }
}

async function deepseekBalance(token, now) {
  try {
    const resp = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return { fetchedAt: now, error: 'HTTP ' + resp.status };
    const j = await resp.json();
    const cny = (j.balance_infos || []).find(b => b.currency === 'CNY');
    return { fetchedAt: now, balance: cny ? String(cny.total_balance) : '' };
  } catch (e) {
    return { fetchedAt: now, error: String((e && e.message) || e) };
  }
}

function readClaudeCredentials() {
  let raw = '';
  try { raw = fs.readFileSync(path.join(lib.CLAUDE_DIR, '.credentials.json'), 'utf8'); } catch {}
  // macOS 的 Claude Code 通常把凭据放在 Keychain，不落明文文件。
  if (!raw && process.platform === 'darwin') {
    try {
      raw = execFileSync('security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    } catch {}
  }
  try { return JSON.parse(raw); } catch { return null; }
}

async function claudeSubscriptionUsage(now) {
  const creds = readClaudeCredentials();
  const oauth = creds && creds.claudeAiOauth;
  const token = String((oauth && oauth.accessToken) || '');
  if (!token) return { fetchedAt: now, error: '未找到 Claude Code 登录凭据' };
  try {
    const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: 'Bearer ' + token,
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });
    const j = await resp.json().catch(() => null);
    if (!resp.ok || !j) {
      const detail = j && j.error && j.error.message;
      return { fetchedAt: now, error: detail || ('HTTP ' + resp.status) };
    }
    const tiers = [];
    for (const [key, kind] of [['five_hour', 'h5'], ['seven_day', 'week']]) {
      const item = j[key];
      if (!item || item.utilization == null) continue;
      tiers.push({
        kind,
        pct: Math.trunc(Number(item.utilization) || 0),
        resetMs: Date.parse(item.resets_at || '') || 0,
      });
    }
    if (!tiers.length) return { fetchedAt: now, error: '当前账号没有可显示的订阅额度' };
    return { fetchedAt: now, tiers };
  } catch (e) {
    return { fetchedAt: now, error: String((e && e.message) || e) };
  }
}

async function queryProviderUsage(p) {
  const now = new Date().toISOString();
  const kind = usageKind(p);
  if (!kind) return null;
  if (kind !== 'subscription' && (!p.token || p.token.includes('在这里填入'))) {
    return { fetchedAt: now, error: '请先填写有效的 API Token' };
  }
  if (/bigmodel\.cn/.test(p.url)) return glmUsage('https://open.bigmodel.cn', p.token, now);
  if (/api\.z\.ai/.test(p.url)) return glmUsage('https://api.z.ai', p.token, now);
  if (kind === 'balance') return deepseekBalance(p.token, now);
  return claudeSubscriptionUsage(now);
}

async function refreshUsage(names = []) {
  // 每次写入前重读缓存，避免 CCM 同时刷新不同卡片时互相覆盖结果。
  const wanted = new Set(names);
  const providers = lib.getProviders().filter(p => !wanted.size || wanted.has(p.name));
  const results = {};

  for (const p of providers) {
    let entry = await queryProviderUsage(p);
    if (!entry) continue;
    const cacheMap = readCache();
    const old = cacheMap[p.name];
    if (entry.error && old && !old.error
        && ((old.tiers && old.tiers.length) || old.balance !== undefined)) {
      entry = { ...old, lastError: entry.error, failedAt: entry.fetchedAt };
    }
    results[p.name] = entry;
    cacheMap[p.name] = entry;
    writeCache(cacheMap);
  }
  return { ...readCache(), ...results };
}

if (require.main === module) {
  refreshUsage(process.argv.slice(2)).catch(() => { process.exitCode = 1; });
}

module.exports = { usageKind, readCache, refreshUsage, queryProviderUsage, clearUsage };
