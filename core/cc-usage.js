#!/usr/bin/env node
'use strict';
// cc-usage.js — 供应商限额/余额查询（结果写缓存，供状态栏显示；由状态栏异步调起）
//
// 数据源（按 ANTHROPIC_BASE_URL 识别）：
//   GLM 套餐（bigmodel.cn / z.ai）   GET {host}/api/monitor/usage/quota/limit（Authorization 用裸 token，不加 Bearer）
//                                     data.limits[] 里 type=TOKENS_LIMIT/CREDIT_LIMIT 的条目：unit=3 → 5小时窗口，unit=6 → 周窗口
//   DeepSeek                          GET https://api.deepseek.com/user/balance（账户余额，CNY）
//   官方/其他                         不查询
//
// 用法: node cc-usage.js [provider 名 ...]    # 缺省刷新全部
// 缓存: ~/.claude/cc-usage-cache.json   （格式 { <名>: { fetchedAt, tiers:[{kind,pct,resetMs}] | balance | error } } ）

const fs = require('fs');
const lib = require('./cc-lib');

const names = process.argv.slice(2);
const now = new Date().toISOString();

async function glmUsage(apiHost, token) {
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

async function deepseekBalance(token) {
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

(async () => {
  // 读旧缓存（保留本次未刷新的条目）
  const cacheMap = {};
  try { Object.assign(cacheMap, JSON.parse(fs.readFileSync(lib.USAGE_CACHE, 'utf8'))); } catch {}

  for (const p of lib.getProviders()) {
    if (names.length && !names.includes(p.name)) continue;
    if (!p.token || p.token.includes('在这里填入')) continue;   // 未填 token 的模板

    let entry = null;
    if (/bigmodel\.cn/.test(p.url)) entry = await glmUsage('https://open.bigmodel.cn', p.token);
    else if (/api\.z\.ai/.test(p.url)) entry = await glmUsage('https://api.z.ai', p.token);
    else if (/api\.deepseek\.com/.test(p.url)) entry = await deepseekBalance(p.token);
    if (entry) cacheMap[p.name] = entry;
  }

  const out = {};
  for (const k of Object.keys(cacheMap).sort()) out[k] = cacheMap[k];
  try { fs.writeFileSync(lib.USAGE_CACHE, JSON.stringify(out, null, 2)); } catch {}
})();
