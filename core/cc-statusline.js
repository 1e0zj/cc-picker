#!/usr/bin/env node
'use strict';
// cc-statusline.js — Claude Code 状态栏
// 显示：[供应商账号] 模型 · 目录 · 上下文用量% （限额/余额推到行右端）
// 识别原理：用当前进程 env 里的 ANTHROPIC_AUTH_TOKEN 匹配 ~/.claude/providers/*.json，
// 匹配不到时按 ANTHROPIC_BASE_URL 判断（空 = 官方）。default 启动同样能识别。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const lib = require('./cc-lib');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  try { main(JSON.parse(input)); } catch { process.stdout.write(''); }
});

function main(data) {
  const model = (data.model && data.model.display_name) || '?';
  const cwd = (data.workspace && data.workspace.current_dir) || '';
  let dirName = path.basename(cwd);
  if (!dirName) dirName = cwd;   // 根目录 basename 为空，退回全路径
  const pct = Math.trunc(Number(data.context_window && data.context_window.used_percentage) || 0);

  // ---- 识别供应商账号 ----
  const token = process.env.ANTHROPIC_AUTH_TOKEN || '';
  const baseUrl = process.env.ANTHROPIC_BASE_URL || '';
  let prov = null;
  if (token) {
    for (const p of lib.getProviders()) {
      if (p.token && p.token === token) { prov = p.name; break; }
    }
  }
  if (!prov) {
    if (!baseUrl.trim()) prov = 'official';
    else prov = baseUrl.replace(/^https?:\/\//, '').split('/')[0];
  }

  // ---- 配色：与 wt tab 颜色完全一致，按厂商归组（glm 系=青 / deepseek 系=蓝 / official=绿 / 其他=黄）----
  const ESC = '\x1b';
  const CEND = ESC + '[0m';
  const ansi = hex => {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return `${ESC}[38;2;${r};${g};${b}m`;
  };
  const provColor = prov === 'official' ? ansi('#2ECC71')
                  : /^glm/i.test(prov) ? ansi('#00B8A9')
                  : /^deepseek/i.test(prov) ? ansi('#4D6FFF')
                  : ansi('#F1C40F');
  const pctColorOf = v => v >= 80 ? ansi('#E74C3C') : v >= 50 ? ansi('#F1C40F') : ansi('#2ECC71');
  const pctColor = pctColorOf(pct);

  // 重置倒计时：>48h 显示 "6d18h"，>1h 显示 "2h31m"，<1h 显示 "37m"；已过期/无效返回空
  const countdown = ms => {
    if (!(ms > 60000)) return '';
    const mins = Math.floor(ms / 60000);
    const h = Math.floor(mins / 60);
    if (h >= 48) { const d = Math.floor(h / 24); return `${d}d${h % 24}h`; }
    if (h > 0) return `${h}h${mins % 60}m`;
    return `${mins}m`;
  };
  const nowMs = Date.now();

  // ---- 限额/余额 ----
  // 官方订阅：stdin 的 rate_limits 直接可用（Pro/Max 才有；API key 供应商无此字段）
  // GLM/DeepSeek：读 cc-usage.js 写的缓存；超过 10 分钟异步刷新（不阻塞状态栏），本次先用旧值
  const updateUsageAsync = prov => {
    // 防抖：2 分钟内已触发过就不再起进程
    let last = 0;
    try { last = Date.parse(fs.readFileSync(lib.USAGE_LOCK, 'utf8').trim()) || 0; } catch {}
    if (Date.now() - last < 120000) return;
    try { fs.writeFileSync(lib.USAGE_LOCK, new Date().toISOString()); } catch {}
    try {
      const child = spawn(process.execPath, [path.join(__dirname, 'cc-usage.js'), prov],
        { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
    } catch {}
  };

  let usageSeg = '';
  if (data.rate_limits) {
    const rl = data.rate_limits;
    // resets_at：重置时间（ISO 字符串），存在时附倒计时
    const resetCd = r => {
      if (!r || !r.resets_at) return '';
      const t = Date.parse(r.resets_at);
      if (!t) return '';
      const cd = countdown(t - nowMs);
      return cd ? ' ' + cd : '';
    };
    const fh = rl.five_hour, sd = rl.seven_day;
    if (fh && fh.used_percentage != null) {
      const p = Math.trunc(+fh.used_percentage);
      usageSeg += ` · 5h ${pctColorOf(p)}${p}%${CEND}${resetCd(fh)}`;
    }
    if (sd && sd.used_percentage != null) {
      const p = Math.trunc(+sd.used_percentage);
      usageSeg += ` · 周 ${pctColorOf(p)}${p}%${CEND}${resetCd(sd)}`;
    }
  } else if (prov !== 'official') {
    let ue = null;
    try { ue = JSON.parse(fs.readFileSync(lib.USAGE_CACHE, 'utf8'))[prov] || null; } catch {}
    if (ue && !ue.error) {
      if (Date.now() - (Date.parse(ue.fetchedAt) || 0) > 10 * 60 * 1000) updateUsageAsync(prov);
      for (const t of (ue.tiers || [])) {
        const p = Math.trunc(+t.pct);
        // 旧缓存无 resetMs 字段时不显示，下一轮缓存刷新（≤10 分钟）自然带上
        const cd = t.resetMs ? countdown(+t.resetMs - nowMs) : '';
        if (t.kind === 'h5')   usageSeg += ` · 5h ${pctColorOf(p)}${p}%${CEND}${cd ? ' ' + cd : ''}`;
        if (t.kind === 'week') usageSeg += ` · 周 ${pctColorOf(p)}${p}%${CEND}${cd ? ' ' + cd : ''}`;
      }
      if (ue.balance) usageSeg += ` · ¥${ue.balance}`;
    } else if (!ue) {
      updateUsageAsync(prov);   // 首次：先触发查询，下一轮状态栏就有数据
    }
  }

  // ---- 布局：ctx 留在左侧，限额推到行右端（免得两类百分比混在一起）----
  // Claude Code 会传 COLUMNS 环境变量；按可见宽度填充（ANSI 色码计 0 列，CJK 计 2 列）
  const visibleWidth = s => {
    const plain = s.replace(/\x1b\[[0-9;]*m/g, '');
    let w = 0;
    for (const ch of plain) {
      // ·(U+00B7) 在中文字体下常按全角渲染，保守计 2 列——宁可右边多留空隙也不能溢出截断
      const c = ch.codePointAt(0);
      if (c >= 0x2E80 || c === 0xB7) w += 2; else w += 1;
    }
    return w;
  };

  const left = `${provColor}[${prov}]${CEND} ${model} · ${dirName} · ctx ${pctColor}${pct}%${CEND}`;
  const right = usageSeg.replace(/^[ ·]+/, '');
  let out = right ? `${left}  ${right}` : left;

  let cols = 0;
  if (/^\d+$/.test(process.env.COLUMNS || '')) cols = +process.env.COLUMNS;
  if (right && cols >= 60) {
    const pad = cols - visibleWidth(left) - visibleWidth(right) - 2;
    if (pad >= 2) out = left + ' '.repeat(pad) + right;
  }

  process.stdout.write(out);
}
