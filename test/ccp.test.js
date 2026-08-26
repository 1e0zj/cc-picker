'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ccp.js 直接执行会启动菜单/claude——以模块方式引入只拿 parseArgs
const { parseArgs } = require('../core/ccp');

test('第一位裸词是 provider 名，其余透传', () => {
  assert.deepEqual(parseArgs([]), { dir: '', pick: '', passthrough: [] });
  assert.deepEqual(parseArgs(['glm']), { dir: '', pick: 'glm', passthrough: [] });
  assert.deepEqual(parseArgs(['glm', '--continue']),
    { dir: '', pick: 'glm', passthrough: ['--continue'] });
  // 无 provider 名：菜单模式，参数照样透传
  assert.deepEqual(parseArgs(['--continue']),
    { dir: '', pick: '', passthrough: ['--continue'] });
});

test('claude 带值参数里的裸词不会被当成 provider 名', () => {
  assert.deepEqual(parseArgs(['--model', 'opus']),
    { dir: '', pick: '', passthrough: ['--model', 'opus'] });
  assert.deepEqual(parseArgs(['glm', '--model', 'opus']),
    { dir: '', pick: 'glm', passthrough: ['--model', 'opus'] });
});

test('--dir 位置任意，路径走 normalizeDir 清洗', () => {
  // 右键菜单场景：盘根 %1 展开成 "C:\"，尾反斜杠吃掉结束引号，收到 C:"
  assert.deepEqual(parseArgs(['--dir', 'C:"', 'glm']),
    { dir: 'C:\\', pick: 'glm', passthrough: [] });
  assert.deepEqual(parseArgs(['glm', '--dir', 'D:\\proj', '--resume']),
    { dir: 'D:\\proj', pick: 'glm', passthrough: ['--resume'] });
});
