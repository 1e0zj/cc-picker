'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const lib = require('../core/cc-lib');
const ccu = require('../core/ccu');

test('countdown 与状态栏同一口径', () => {
  assert.equal(lib.countdown(90 * 60000), '1h30m');
  assert.equal(lib.countdown((6 * 24 + 18) * 3600000), '6d18h');
  assert.equal(lib.countdown(37 * 60000), '37m');
  // 不足一分钟 / 已过期 / 无效 → 空
  assert.equal(lib.countdown(30000), '');
  assert.equal(lib.countdown(0), '');
  assert.equal(lib.countdown(-1), '');
});

test('fmtTier 上色与倒计时括号', () => {
  const soon = Date.now() + 90 * 60000;
  const out = ccu.fmtTier({ pct: 85, resetMs: soon });
  assert.ok(out.includes('85%'));
  assert.ok(out.includes('(1h30m)'));
  // TTY 下的转义必须是合法真彩序列（R;G;B 数字）——塞 "#RRGGBB" 会被终端
  // 吞一半、漏出 "CC71m" 之类的字面残骸
  const tty = process.stdout.isTTY;
  process.stdout.isTTY = true;
  try {
    assert.match(ccu.fmtTier({ pct: 79, resetMs: 0 }), /^\x1b\[38;2;241;196;15m 79%\x1b\[0m$/);
  } finally { process.stdout.isTTY = tty; }
  // 重置时间缺失/已过 → 只有百分比
  assert.equal(ccu.fmtTier({ pct: 10, resetMs: 0 }), ' 10%');
  // 无该档位 → 占位
  assert.equal(ccu.fmtTier(undefined), '—');
});

test('fmtEntry 按 provider 类型分派', () => {
  const glm = { name: 'glm', url: 'https://open.bigmodel.cn/api/anthropic', token: 'x' };
  const ds = { name: 'deepseek', url: 'https://api.deepseek.com', token: 'x' };
  const other = { name: 'proxy', url: 'https://elsewhere', token: 'x' };
  assert.ok(ccu.fmtEntry(glm, { tiers: [{ kind: 'h5', pct: 40, resetMs: 0 }] }).includes('5h'));
  // 没有周限额的套餐不显示 周 列（同网页/状态栏口径）
  assert.ok(!ccu.fmtEntry(glm, { tiers: [{ kind: 'h5', pct: 40, resetMs: 0 }] }).includes('周'));
  assert.equal(ccu.fmtEntry(ds, { balance: '87.20' }), '余额 ¥87.20');
  assert.equal(ccu.fmtEntry(other, undefined), '—');
  assert.ok(ccu.fmtEntry(glm, { error: 'HTTP 401' }).includes('HTTP 401'));
});

test('5h 列定宽，周 纵向对齐（含 TTY 上色）', () => {
  const p = { name: 'glm', url: 'https://open.bigmodel.cn/api/anthropic', token: 'x' };
  const entry = tiers => ({ tiers });
  const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  const col5h = e => strip(ccu.fmtEntry(p, e)).indexOf('周');
  const withCd = entry([{ kind: 'h5', pct: 1, resetMs: Date.now() + 3600000 },
                        { kind: 'week', pct: 35, resetMs: Date.now() + 86400000 }]);
  const noCd = entry([{ kind: 'h5', pct: 0, resetMs: 0 }, { kind: 'week', pct: 79, resetMs: 0 }]);
  assert.equal(col5h(withCd), col5h(noCd));
  // TTY 下（fmtTier 带转义码）也不能歪
  const tty = process.stdout.isTTY;
  process.stdout.isTTY = true;
  try { assert.equal(col5h(withCd), col5h(noCd)); }
  finally { process.stdout.isTTY = tty; }
});

test('fmtAge 超过 10 分钟才标龄', () => {
  assert.equal(ccu.fmtAge({ fetchedAt: new Date().toISOString() }), '');
  assert.equal(ccu.fmtAge(undefined), '');
  const old = new Date(Date.now() - 3 * 3600000).toISOString();
  assert.ok(ccu.fmtAge({ fetchedAt: old }).includes('3h0m前'));
});
