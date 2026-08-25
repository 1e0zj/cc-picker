#!/usr/bin/env node
'use strict';
// cc-menu.js — 文件管理器右键菜单「Claude Code（选模型）」的安装 / 卸载
//
// 右键一个文件夹 → 新终端窗口在该目录打开 → ccp 的菜单选供应商 → 启动 claude。
// 选择界面复用 ccp 自己的终端菜单，不需要额外 GUI。
//
// Windows  HKCU\Software\Classes\Directory\shell（文件夹上右键）
//          + Directory\Background\shell（文件夹空白处右键），均不需要管理员
// macOS    ~/Library/Services 下的 Automator 快速操作（Finder 右键 →「快速操作」）
// Linux    各文件管理器机制互不相同（Nautilus scripts / Dolphin ServiceMenu /
//          Thunar custom actions），没有统一入口，不做——用 ccp 即可
//
// 用法: node cc-menu.js [install|uninstall|status]

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const lib = require('./cc-lib');

const MENU_TITLE = 'Claude Code（选模型）';
const CCP = path.join(lib.CLAUDE_DIR, 'ccp.js');

// ---------- Windows ----------

const REG_KEYS = [
  // Directory 传 %1（被右键的文件夹），Background 传 %V（当前打开的目录）
  { key: 'HKCU\\Software\\Classes\\Directory\\shell\\ClaudePicker', arg: '%1' },
  { key: 'HKCU\\Software\\Classes\\Directory\\Background\\shell\\ClaudePicker', arg: '%V' },
];

// WindowsApps 下的 wt.exe 是「应用执行别名」——零字节 reparse point，
// fs.existsSync / statSync 对它是 EACCES→false，只有 accessSync(X_OK) 认得
function canExec(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

function findWindowsTerminal() {
  const alias = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'wt.exe');
  if (process.env.LOCALAPPDATA && canExec(alias)) return alias;
  const r = spawnSync('where', ['wt.exe'], { encoding: 'utf8' });
  if (r.status === 0) {
    // where 找得到就是能跑，不用 existsSync 复核（同样会栽在别名上）
    const first = String(r.stdout).split(/\r?\n/).map(x => x.trim()).find(Boolean);
    if (first) return first;
  }
  return '';
}

// 菜单项图标：优先原生安装位置，其次 npm 全局装的 claude.exe
function findClaudeIcon() {
  const cands = [
    path.join(lib.HOME, '.local', 'bin', 'claude.exe'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules',
      '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
  ];
  for (const c of cands) if (canExec(c)) return c;
  return '';
}

// cmd /k 而不是 /c：claude 退出后窗口留着，ccp 报错也看得见
// （路径不在这里 cd——%1/%V 在盘根目录会展开成 "C:\"，尾部反斜杠把结束引号吃掉，
//   交给 ccp.js --dir 统一清洗，见 ccp.js 的 normalizeDir）
function windowsCommand(arg) {
  const wt = findWindowsTerminal();
  const inner = `cmd /k node "${CCP}" --dir "${arg}"`;
  return wt ? `"${wt}" ${inner}` : `cmd.exe /c start "${MENU_TITLE}" ${inner}`;
}

function reg(args) {
  return execFileSync('reg', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function windowsInstall() {
  const icon = findClaudeIcon();
  for (const { key, arg } of REG_KEYS) {
    reg(['add', key, '/ve', '/d', MENU_TITLE, '/f']);
    if (icon) reg(['add', key, '/v', 'Icon', '/d', icon, '/f']);
    reg(['add', key + '\\command', '/ve', '/d', windowsCommand(arg), '/f']);
  }
  console.log(`右键菜单已安装：任意文件夹（或文件夹空白处）右键 →「${MENU_TITLE}」`);
  if (!findWindowsTerminal()) {
    console.log('未找到 Windows Terminal，退回 cmd 窗口；装了 wt 后重跑本命令可切过去。');
  }
}

function windowsUninstall() {
  let n = 0;
  for (const { key } of REG_KEYS) {
    try { reg(['delete', key, '/f']); n++; } catch {}
  }
  console.log(n ? '右键菜单已移除' : '右键菜单本来就没装');
}

function windowsStatus() {
  for (const { key } of REG_KEYS) {
    let line = '未安装';
    try {
      const out = reg(['query', key + '\\command', '/ve']);
      // reg.exe 按控制台代码页输出，中文菜单名读回来是乱码——只认 ASCII 的命令路径
      const m = out.match(/[A-Za-z]:\\[^"]*ccp\.js/);
      line = m ? '已安装 → ' + m[0] : '已安装';
    } catch {}
    console.log('  ' + key.replace('HKCU\\Software\\Classes\\', '') + ': ' + line);
  }
}

// ---------- macOS ----------

const SERVICE_DIR = path.join(lib.HOME, 'Library', 'Services', 'ClaudePicker.workflow');

const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Automator 的 Run Shell Script（inputMethod=1 → 文件夹路径作为位置参数传入）
function macScript() {
  return [
    '# 由 cc-picker 生成：在被右键的目录开一个 Terminal 窗口跑 ccp',
    'for d in "$@"; do',
    '  esc=$(printf %s "$d" | sed "s/\'/\'\\\\\\\\\'\'/g")',
    '  osascript \\',
    '    -e "tell application \\"Terminal\\" to do script \\"cd \'$esc\' && node \'' + CCP + '\'\\"" \\',
    '    -e \'tell application "Terminal" to activate\'',
    'done',
  ].join('\n');
}

function macInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDevelopmentRegion</key>
\t<string>en</string>
\t<key>CFBundleIdentifier</key>
\t<string>io.github.cc-picker.finder-service</string>
\t<key>CFBundleInfoDictionaryVersion</key>
\t<string>6.0</string>
\t<key>CFBundleName</key>
\t<string>${xml(MENU_TITLE)}</string>
\t<key>CFBundlePackageType</key>
\t<string>APPL</string>
\t<key>NSServices</key>
\t<array>
\t\t<dict>
\t\t\t<key>NSMenuItem</key>
\t\t\t<dict>
\t\t\t\t<key>default</key>
\t\t\t\t<string>${xml(MENU_TITLE)}</string>
\t\t\t</dict>
\t\t\t<key>NSMessage</key>
\t\t\t<string>runWorkflowAsService</string>
\t\t\t<key>NSRequiredContext</key>
\t\t\t<dict>
\t\t\t\t<key>NSApplicationIdentifier</key>
\t\t\t\t<string>com.apple.finder</string>
\t\t\t</dict>
\t\t\t<key>NSSendFileTypes</key>
\t\t\t<array>
\t\t\t\t<string>public.folder</string>
\t\t\t</array>
\t\t</dict>
\t</array>
</dict>
</plist>
`;
}

function macWorkflow() {
  const u = () => crypto.randomUUID().toUpperCase();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>AMApplicationBuild</key>
\t<string>523</string>
\t<key>AMApplicationVersion</key>
\t<string>2.10</string>
\t<key>AMDocumentVersion</key>
\t<string>2</string>
\t<key>actions</key>
\t<array>
\t\t<dict>
\t\t\t<key>action</key>
\t\t\t<dict>
\t\t\t\t<key>AMAccepts</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>Container</key>
\t\t\t\t\t<string>List</string>
\t\t\t\t\t<key>Optional</key>
\t\t\t\t\t<true/>
\t\t\t\t\t<key>Types</key>
\t\t\t\t\t<array>
\t\t\t\t\t\t<string>com.apple.cocoa.string</string>
\t\t\t\t\t</array>
\t\t\t\t</dict>
\t\t\t\t<key>AMActionVersion</key>
\t\t\t\t<string>2.0.3</string>
\t\t\t\t<key>AMApplication</key>
\t\t\t\t<array>
\t\t\t\t\t<string>Automator</string>
\t\t\t\t</array>
\t\t\t\t<key>AMParameterProperties</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>COMMAND_STRING</key>
\t\t\t\t\t<dict/>
\t\t\t\t\t<key>CheckedForUserDefaultShell</key>
\t\t\t\t\t<dict/>
\t\t\t\t\t<key>inputMethod</key>
\t\t\t\t\t<dict/>
\t\t\t\t\t<key>shell</key>
\t\t\t\t\t<dict/>
\t\t\t\t\t<key>source</key>
\t\t\t\t\t<dict/>
\t\t\t\t</dict>
\t\t\t\t<key>AMProvides</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>Container</key>
\t\t\t\t\t<string>List</string>
\t\t\t\t\t<key>Types</key>
\t\t\t\t\t<array>
\t\t\t\t\t\t<string>com.apple.cocoa.string</string>
\t\t\t\t\t</array>
\t\t\t\t</dict>
\t\t\t\t<key>ActionBundlePath</key>
\t\t\t\t<string>/System/Library/Automator/Run Shell Script.action</string>
\t\t\t\t<key>ActionName</key>
\t\t\t\t<string>Run Shell Script</string>
\t\t\t\t<key>ActionParameters</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>COMMAND_STRING</key>
\t\t\t\t\t<string>${xml(macScript())}</string>
\t\t\t\t\t<key>CheckedForUserDefaultShell</key>
\t\t\t\t\t<true/>
\t\t\t\t\t<key>inputMethod</key>
\t\t\t\t\t<integer>1</integer>
\t\t\t\t\t<key>shell</key>
\t\t\t\t\t<string>/bin/zsh</string>
\t\t\t\t\t<key>source</key>
\t\t\t\t\t<string></string>
\t\t\t\t</dict>
\t\t\t\t<key>BundleIdentifier</key>
\t\t\t\t<string>com.apple.RunShellScript</string>
\t\t\t\t<key>CFBundleVersion</key>
\t\t\t\t<string>2.0.3</string>
\t\t\t\t<key>CanShowSelectedItemsWhenRun</key>
\t\t\t\t<false/>
\t\t\t\t<key>CanShowWhenRun</key>
\t\t\t\t<true/>
\t\t\t\t<key>Category</key>
\t\t\t\t<array>
\t\t\t\t\t<string>AMCategoryUtilities</string>
\t\t\t\t</array>
\t\t\t\t<key>Class Name</key>
\t\t\t\t<string>RunShellScriptAction</string>
\t\t\t\t<key>InputUUID</key>
\t\t\t\t<string>${u()}</string>
\t\t\t\t<key>Keywords</key>
\t\t\t\t<array>
\t\t\t\t\t<string>Shell</string>
\t\t\t\t\t<string>Script</string>
\t\t\t\t\t<string>Command</string>
\t\t\t\t\t<string>Run</string>
\t\t\t\t\t<string>Unix</string>
\t\t\t\t</array>
\t\t\t\t<key>OutputUUID</key>
\t\t\t\t<string>${u()}</string>
\t\t\t\t<key>UUID</key>
\t\t\t\t<string>${u()}</string>
\t\t\t\t<key>UnlocalizedApplications</key>
\t\t\t\t<array>
\t\t\t\t\t<string>Automator</string>
\t\t\t\t</array>
\t\t\t\t<key>arguments</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>0</key>
\t\t\t\t\t<dict>
\t\t\t\t\t\t<key>default value</key>
\t\t\t\t\t\t<integer>0</integer>
\t\t\t\t\t\t<key>name</key>
\t\t\t\t\t\t<string>inputMethod</string>
\t\t\t\t\t\t<key>required</key>
\t\t\t\t\t\t<string>0</string>
\t\t\t\t\t\t<key>type</key>
\t\t\t\t\t\t<string>0</string>
\t\t\t\t\t\t<key>uuid</key>
\t\t\t\t\t\t<string>0</string>
\t\t\t\t\t</dict>
\t\t\t\t\t<key>1</key>
\t\t\t\t\t<dict>
\t\t\t\t\t\t<key>default value</key>
\t\t\t\t\t\t<false/>
\t\t\t\t\t\t<key>name</key>
\t\t\t\t\t\t<string>CheckedForUserDefaultShell</string>
\t\t\t\t\t\t<key>required</key>
\t\t\t\t\t\t<string>0</string>
\t\t\t\t\t\t<key>type</key>
\t\t\t\t\t\t<string>0</string>
\t\t\t\t\t\t<key>uuid</key>
\t\t\t\t\t\t<string>1</string>
\t\t\t\t\t</dict>
\t\t\t\t\t<key>2</key>
\t\t\t\t\t<dict>
\t\t\t\t\t\t<key>default value</key>
\t\t\t\t\t\t<string></string>
\t\t\t\t\t\t<key>name</key>
\t\t\t\t\t\t<string>source</string>
\t\t\t\t\t\t<key>required</key>
\t\t\t\t\t\t<string>0</string>
\t\t\t\t\t\t<key>type</key>
\t\t\t\t\t\t<string>0</string>
\t\t\t\t\t\t<key>uuid</key>
\t\t\t\t\t\t<string>2</string>
\t\t\t\t\t</dict>
\t\t\t\t\t<key>3</key>
\t\t\t\t\t<dict>
\t\t\t\t\t\t<key>default value</key>
\t\t\t\t\t\t<string></string>
\t\t\t\t\t\t<key>name</key>
\t\t\t\t\t\t<string>COMMAND_STRING</string>
\t\t\t\t\t\t<key>required</key>
\t\t\t\t\t\t<string>0</string>
\t\t\t\t\t\t<key>type</key>
\t\t\t\t\t\t<string>0</string>
\t\t\t\t\t\t<key>uuid</key>
\t\t\t\t\t\t<string>3</string>
\t\t\t\t\t</dict>
\t\t\t\t\t<key>4</key>
\t\t\t\t\t<dict>
\t\t\t\t\t\t<key>default value</key>
\t\t\t\t\t\t<string>/bin/sh</string>
\t\t\t\t\t\t<key>name</key>
\t\t\t\t\t\t<string>shell</string>
\t\t\t\t\t\t<key>required</key>
\t\t\t\t\t\t<string>0</string>
\t\t\t\t\t\t<key>type</key>
\t\t\t\t\t\t<string>0</string>
\t\t\t\t\t\t<key>uuid</key>
\t\t\t\t\t\t<string>4</string>
\t\t\t\t\t</dict>
\t\t\t\t</dict>
\t\t\t\t<key>isViewVisible</key>
\t\t\t\t<integer>1</integer>
\t\t\t\t<key>location</key>
\t\t\t\t<string>309.000000:253.000000</string>
\t\t\t\t<key>nibPath</key>
\t\t\t\t<string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
\t\t\t</dict>
\t\t\t<key>isViewVisible</key>
\t\t\t<integer>1</integer>
\t\t</dict>
\t</array>
\t<key>connectors</key>
\t<dict/>
\t<key>workflowMetaData</key>
\t<dict>
\t\t<key>serviceApplicationBundleID</key>
\t\t<string>com.apple.finder</string>
\t\t<key>serviceApplicationPath</key>
\t\t<string>/System/Library/CoreServices/Finder.app</string>
\t\t<key>serviceInputTypeIdentifier</key>
\t\t<string>com.apple.Automator.fileSystemObject.folder</string>
\t\t<key>serviceOutputTypeIdentifier</key>
\t\t<string>com.apple.Automator.nothing</string>
\t\t<key>serviceProcessesInput</key>
\t\t<integer>0</integer>
\t\t<key>workflowTypeIdentifier</key>
\t\t<string>com.apple.Automator.servicesMenu</string>
\t</dict>
</dict>
</plist>
`;
}

function macInstall() {
  const contents = path.join(SERVICE_DIR, 'Contents');
  fs.mkdirSync(contents, { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), macInfoPlist());
  fs.writeFileSync(path.join(contents, 'document.wflow'), macWorkflow());
  // 让 Finder 立刻看到新服务，省得等系统自己扫
  try {
    execFileSync('/System/Library/CoreServices/pbs', ['-flush'], { stdio: 'ignore' });
  } catch {}
  console.log(`快速操作已安装：${SERVICE_DIR}`);
  console.log(`Finder 里右键文件夹 →「快速操作」→「${MENU_TITLE}」`);
  console.log('没看到的话，去 系统设置 → 键盘 → 键盘快捷键 → 服务 里把它勾上。');
}

function macUninstall() {
  if (fs.existsSync(SERVICE_DIR)) {
    fs.rmSync(SERVICE_DIR, { recursive: true, force: true });
    console.log('快速操作已移除');
  } else {
    console.log('快速操作本来就没装');
  }
}

function macStatus() {
  console.log('  ' + SERVICE_DIR + ': ' + (fs.existsSync(SERVICE_DIR) ? '已安装' : '未安装'));
}

// ---------- 分发 ----------

const UNSUPPORTED = 'cc-menu: 只支持 Windows 与 macOS——Linux 各文件管理器机制不同，请直接用 ccp';

function menuInstall() {
  if (process.platform === 'win32') return windowsInstall();
  if (process.platform === 'darwin') return macInstall();
  console.error(UNSUPPORTED);
  process.exitCode = 1;
}

function menuUninstall() {
  if (process.platform === 'win32') return windowsUninstall();
  if (process.platform === 'darwin') return macUninstall();
  console.error(UNSUPPORTED);
  process.exitCode = 1;
}

function menuStatus() {
  if (process.platform === 'win32') return windowsStatus();
  if (process.platform === 'darwin') return macStatus();
  console.log('  不支持当前平台（' + process.platform + '）');
}

if (require.main === module) {
  const cmd = process.argv[2] || 'install';
  if (cmd === 'install') menuInstall();
  else if (cmd === 'uninstall') menuUninstall();
  else if (cmd === 'status') menuStatus();
  else {
    console.error(`未知命令: ${cmd}\n用法: node cc-menu.js [install|uninstall|status]`);
    process.exitCode = 1;
  }
}

module.exports = { menuInstall, menuUninstall, menuStatus, MENU_TITLE,
  // 下面几个只是给测试用：命令行拼装与 plist 生成
  windowsCommand, macInfoPlist, macWorkflow };
