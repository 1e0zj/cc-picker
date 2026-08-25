'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-picker-menu-'));
process.env.CC_HOME = testHome;

const lib = require('../core/cc-lib');
const menu = require('../core/cc-menu');

test.after(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

test('cleans up the directory the shell hands over', () => {
  // 盘根：注册表的 "%1" 展开成 "C:\"，尾部反斜杠把结束引号吃掉，程序收到 C:"
  assert.equal(lib.normalizeDir('C:"'), 'C:\\');
  assert.equal(lib.normalizeDir('C:'), 'C:\\');
  assert.equal(lib.normalizeDir('"D:\\code\\cc-picker"'), 'D:\\code\\cc-picker');
  assert.equal(lib.normalizeDir('D:\\code\\cc-picker'), 'D:\\code\\cc-picker');
  assert.equal(lib.normalizeDir('  /Users/me/proj  '), '/Users/me/proj');
  assert.equal(lib.normalizeDir(''), '');
  assert.equal(lib.normalizeDir(undefined), '');
});

test('windows menu command defers the path to ccp --dir', () => {
  for (const arg of ['%1', '%V']) {
    const cmd = menu.windowsCommand(arg);
    assert.match(cmd, new RegExp('--dir "' + arg + '"'));
    assert.ok(cmd.includes(path.join(lib.CLAUDE_DIR, 'ccp.js')));
    // cmd /k：claude 退出后窗口留着，ccp 报错也看得见
    assert.match(cmd, /cmd \/k/);
  }
});

test('macOS service plists are well-formed and escaped', () => {
  const wf = menu.macWorkflow();
  // 脚本里的 shell && 必须转义，否则 plist 不是合法 XML
  assert.ok(wf.includes('&amp;&amp;'));
  assert.ok(!wf.includes('&&'));
  assert.match(wf, /com\.apple\.Automator\.servicesMenu/);
  assert.match(wf, /com\.apple\.Automator\.fileSystemObject\.folder/);
  // inputMethod=1：文件夹路径作为位置参数传给脚本，不是走 stdin
  assert.match(wf, /<key>inputMethod<\/key>\s*<integer>1<\/integer>/);
  assert.ok(wf.includes(path.join(lib.CLAUDE_DIR, 'ccp.js')));

  const info = menu.macInfoPlist();
  assert.match(info, /<key>NSServices<\/key>/);
  assert.match(info, /runWorkflowAsService/);
  assert.match(info, /com\.apple\.finder/);
  assert.match(info, /public\.folder/);
  assert.ok(info.includes(menu.MENU_TITLE));
});
