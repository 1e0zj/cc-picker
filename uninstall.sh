#!/usr/bin/env bash
# uninstall.sh — 卸载 cc 多供应商启动器（macOS / Linux）
#
# providers/*.json 含 token，默认保留；确认不要了手动执行:
#     rm -rf ~/.claude/providers

set -euo pipefail

# 1. shell 配置里的标记块
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [ -f "$rc" ]; then
        perl -0777 -i -pe 's/# >>> cc 多供应商启动器 >>>.*?# <<< cc 多供应商启动器 <<<\n?//gs' "$rc"
        echo "已清理 $rc"
    fi
done

# 2. 右键菜单（macOS 的 Finder 快速操作；没装也不报错）
if [ "$(uname -s)" = "Darwin" ] && [ -f "$HOME/.claude/cc-menu.js" ]; then
    node "$HOME/.claude/cc-menu.js" uninstall || true
fi

# 3. 脚本与缓存（providers 保留）
rm -f "$HOME/.claude/ccp.js" \
      "$HOME/.claude/ccm.js" \
      "$HOME/.claude/ccm-page.html" \
      "$HOME/.claude/cc-statusline.js" \
      "$HOME/.claude/cc-usage.js" \
      "$HOME/.claude/cc-lib.js" \
      "$HOME/.claude/cc-menu.js" \
      "$HOME/.claude/cc-usage-cache.json" \
      "$HOME/.claude/cc-usage.last"
echo '已删除 ~/.claude/ 下的 cc 系列脚本与缓存'

# 4. settings.json 里删掉本项目写入的 statusLine（仅当它指向 cc-statusline.js）
node -e '
const fs = require("fs");
const p = process.env.HOME + "/.claude/settings.json";
if (!fs.existsSync(p)) process.exit(0);
let j;
try { j = JSON.parse(fs.readFileSync(p, "utf8")); } catch { process.exit(0); }
if (j.statusLine && String(j.statusLine.command || "").includes("cc-statusline")) {
  delete j.statusLine;
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  console.log("settings.json 已移除 statusLine");
}'

echo '卸载完成（providers/*.json 保留，如需删除: rm -rf ~/.claude/providers）'
