#!/usr/bin/env node
'use strict';
// postinstall.js — npm 装完自动把 core/*.js 刷进 ~/.claude
//
// 为什么需要它：~/.claude 下跑的是安装时复制的副本（statusLine、shell 函数、
// 右键菜单都写死指向那个稳定路径），npm 换包只换 node_modules 里的源文件。
// 有了这一步，`npm install -g cc-picker@latest` 就等于完成了更新。
//
// 两条自我约束：
//   1. 只刷新已经装过的机器——首次安装什么都不做，环境改动（statusLine /
//      shell 函数 / 右键菜单）留给 cc-picker install 显式决定
//   2. 只刷脚本文件，不碰 providers、settings.json、shell 配置、注册表

const fs = require('fs');
const path = require('path');
const os = require('os');

const { CORE_FILES } = require('./cli.js');

const HOME = process.env.CC_HOME || os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const CORE_DIR = path.join(__dirname, '..', 'core');

function main() {
  // 被当作别的项目的依赖装进来时不该碰用户的 ~/.claude。
  // 个别包管理器不设这个变量——那就什么也不做，cc-picker update 仍然管用。
  if (process.env.npm_config_global !== 'true') return;

  if (!fs.existsSync(path.join(CLAUDE_DIR, 'ccp.js'))) {
    console.log('cc-picker: 跑一次 `cc-picker install` 完成安装');
    return;
  }

  const changed = [];
  for (const f of CORE_FILES) {
    const src = path.join(CORE_DIR, f);
    const dst = path.join(CLAUDE_DIR, f);
    try {
      if (fs.readFileSync(src, 'utf8') === fs.readFileSync(dst, 'utf8')) continue;
    } catch { /* 目标缺失或读不了，照抄一份 */ }
    fs.copyFileSync(src, dst);
    changed.push(f);
  }

  const v = require('../package.json').version;
  if (changed.length) {
    console.log(`cc-picker: ~/.claude 下的脚本已刷新到 v${v}（${changed.join(', ')}）`);
  }
}

// postinstall 抛异常会让整个 npm install 失败——这里一律吞掉
try { main(); } catch { /* 刷新失败不是致命问题，cc-picker update 还能补 */ }
