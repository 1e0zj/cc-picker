'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-picker-usage-'));
process.env.CC_HOME = testHome;

const usage = require('../core/cc-usage');
const lib = require('../core/cc-lib');

test.after(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

test('recognizes supported usage providers', () => {
  assert.equal(usage.usageKind({ url: 'https://open.bigmodel.cn/api/anthropic', token: 'x' }), 'quota');
  assert.equal(usage.usageKind({ url: 'https://api.z.ai/api/anthropic', token: 'x' }), 'quota');
  assert.equal(usage.usageKind({ url: 'https://api.deepseek.com/anthropic', token: 'x' }), 'balance');
  assert.equal(usage.usageKind({ url: '', token: '' }), 'subscription');
  assert.equal(usage.usageKind({ url: '', token: 'sk-ant-api-key' }), '');
});

test('normalizes GLM quota windows', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit');
    assert.equal(options.headers.Authorization, 'glm-token');
    return {
      status: 200,
      json: async () => ({ success: true, data: { limits: [
        { type: 'TOKENS_LIMIT', unit: 3, percentage: 35, nextResetTime: 1900000000000 },
        { type: 'CREDIT_LIMIT', unit: 6, percentage: 63, nextResetTime: 1900100000000 },
        { type: 'TIME_LIMIT', unit: 6, percentage: 99, nextResetTime: 1900200000000 },
      ] } }),
    };
  };
  try {
    const result = await usage.queryProviderUsage({
      url: 'https://open.bigmodel.cn/api/anthropic', token: 'glm-token',
    });
    assert.deepEqual(result.tiers, [
      { kind: 'h5', pct: 35, resetMs: 1900000000000 },
      { kind: 'week', pct: 63, resetMs: 1900100000000 },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('normalizes DeepSeek CNY balance', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/user/balance');
    assert.equal(options.headers.Authorization, 'Bearer ds-token');
    return {
      ok: true,
      json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: '91.52' }] }),
    };
  };
  try {
    const result = await usage.queryProviderUsage({
      url: 'https://api.deepseek.com/anthropic', token: 'ds-token',
    });
    assert.equal(result.balance, '91.52');
  } finally {
    global.fetch = originalFetch;
  }
});

test('uses the local Claude Code OAuth credential for official quota', async () => {
  fs.mkdirSync(lib.CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(path.join(lib.CLAUDE_DIR, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'oauth-test-token' },
  }));
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(options.headers.Authorization, 'Bearer oauth-test-token');
    assert.equal(options.headers['anthropic-beta'], 'oauth-2025-04-20');
    return {
      ok: true,
      json: async () => ({
        five_hour: { utilization: 1, resets_at: '2030-01-01T01:00:00Z' },
        seven_day: { utilization: 20, resets_at: '2030-01-07T01:00:00Z' },
      }),
    };
  };
  try {
    const result = await usage.queryProviderUsage({ url: '', token: '' });
    assert.deepEqual(result.tiers.map(t => ({ kind: t.kind, pct: t.pct })), [
      { kind: 'h5', pct: 1 }, { kind: 'week', pct: 20 },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('keeps the last successful value when a refresh fails', async () => {
  fs.mkdirSync(lib.PROVIDERS_DIR, { recursive: true });
  fs.writeFileSync(path.join(lib.PROVIDERS_DIR, 'glm.json'), JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'glm-token',
  } }));
  const old = {
    fetchedAt: '2029-01-01T00:00:00.000Z',
    tiers: [{ kind: 'h5', pct: 35, resetMs: 1900000000000 }],
  };
  fs.writeFileSync(lib.USAGE_CACHE, JSON.stringify({ glm: old }));
  const originalFetch = global.fetch;
  global.fetch = async () => ({ status: 503, json: async () => null });
  try {
    const cache = await usage.refreshUsage(['glm']);
    assert.deepEqual(cache.glm.tiers, old.tiers);
    assert.match(cache.glm.lastError, /HTTP 503/);
    assert.equal(cache.glm.fetchedAt, old.fetchedAt);
  } finally {
    global.fetch = originalFetch;
  }
});
