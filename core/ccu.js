#!/usr/bin/env node
'use strict';
// ccu.js — 供应商限额/余额的命令行速览（免去开 Claude Code 或 ccm 网页）
//
// 查询逻辑与数据源复用 cc-usage.js（GLM 套餐限额 / DeepSeek 余额 / Claude 官方订阅），
// 跑一次现场查询并写回状态栏共用的缓存——ccu 看完，状态栏的数据也是新的。
// 百分比配色与重置倒计时（6d18h / 2h31m / 37m）跟状态栏同一口径。
//
// 用法: ccu [provider 名 ...]    # 缺省查全部

const lib = require('./cc-lib');
const { refreshUsage, usageKind } = require('./cc-usage');

// 管道输出时去色，终端里才上色（每次现读 isTTY，测试可注入）。真彩序列要
// R;G;B 数字，塞 "#RRGGBB" 会整段变非法序列被终端吞一半、剩一半字面漏出来
const col = (hex, s) => {
  if (!process.stdout.isTTY) return String(s);
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
};
const pctColorOf = v => v >= 80 ? '#E74C3C' : v >= 50 ? '#F1C40F' : '#2ECC71';

function fmtTier(t) {
  if (!t) return '—';
  const cd = t.resetMs && t.resetMs > Date.now()
    ? ' (' + lib.countdown(t.resetMs - Date.now()) + ')' : '';
  return col(pctColorOf(t.pct), String(t.pct).padStart(3) + '%') + cd;
}

// 数据超过 10 分钟才标龄（新鲜数据不标，行尾灰字如 "· 2h31m前"）
function fmtAge(entry) {
  const ms = entry && Date.parse(entry.fetchedAt);
  if (!ms || Date.now() - ms < 600000) return '';
  return '  ' + col('#7F8C8D', '· ' + lib.countdown(Date.now() - ms) + '前');
}

function fmtEntry(p, entry) {
  const kind = usageKind(p);
  if (!kind) return '—';                      // 该供应商没有查询支持
  if (!entry) return col('#7F8C8D', '未查询');
  if (entry.error) return col('#E74C3C', '✗ ' + entry.error);
  if (entry.balance !== undefined) return '余额 ¥' + entry.balance;
  const tier = k => (entry.tiers || []).find(t => t.kind === k);
  // 5h 列定宽，周 才能纵向对齐：tier 最宽 "100% (10h14m)" 11 字符，pad 12。
  // pad 按可见宽度算——直接 padEnd 会把 ANSI 转义算进去补错
  const padTier = s => s + ' '.repeat(Math.max(0, 12 - s.replace(/\x1b\[[0-9;]*m/g, '').length));
  return `5h ${padTier(fmtTier(tier('h5')))} 周 ${fmtTier(tier('week'))}`;
}

async function main() {
  const names = process.argv.slice(2);
  const cache = await refreshUsage(names);
  // 指定了名字就只查、只看那几家；缺省全部
  const wanted = new Set(names);
  const providers = lib.getProviders().filter(p => !wanted.size || wanted.has(p.name));
  if (!providers.length) {
    console.log('没有可用的 provider 配置——先跑 ccm 添加');
    process.exitCode = 1;
    return;
  }
  const width = Math.max(...providers.map(p => p.name.length));
  for (const p of providers) {
    const entry = cache[p.name];
    console.log(p.name.padEnd(width) + '  ' + fmtEntry(p, entry) + fmtAge(entry));
  }
}

if (require.main === module) {
  main().catch(e => { console.error('ccu: ' + e.message); process.exitCode = 1; });
}

module.exports = { fmtTier, fmtAge, fmtEntry };   // 供测试
