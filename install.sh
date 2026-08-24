#!/usr/bin/env bash
# install.sh — Claude Code 多供应商启动器 一键安装（macOS / Linux，自包含，无外部依赖）
#
# 在新机器上执行（需已安装 Claude Code 与 Node 18+）：
#     bash install.sh
#
# 会安装：
#   1. ~/.claude/ccp.js / ccm.js / ccm-page.html / cc-statusline.js / cc-usage.js / cc-lib.js
#   2. ~/.claude/providers/*.json          供应商配置模板（已存在的不覆盖）
#   3. ~/.bashrc（及 zsh 用户的 ~/.zshrc）的 ccp / ccm 命令（幂等，可重复执行）
#   4. ~/.claude/settings.json 的 statusLine 键
#
# 不包含：各供应商的 token（模板留占位，从旧机器拷 providers/*.json 或用 ccm 填写）

set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_DIR="$SRC_DIR/core"
CLAUDE_DIR="$HOME/.claude"
PROVIDERS_DIR="$CLAUDE_DIR/providers"

echo '== Claude Code 多供应商启动器 安装 =='

# 0. 前置检查
if ! command -v node >/dev/null 2>&1; then
    echo '错误: 未找到 node——请先安装 Node.js 18+（Claude Code 本身依赖 Node）' >&2
    exit 1
fi
if ! node -e 'const v=process.versions.node.split(".").map(Number); if(v[0]<18){process.exit(1)}'; then
    echo "错误: 需要 Node 18+，当前 $(node --version)" >&2
    exit 1
fi
if ! command -v claude >/dev/null 2>&1; then
    echo '警告: 未在 PATH 找到 claude 命令——请先安装 Claude Code' >&2
fi

# 1. 核心脚本
mkdir -p "$CLAUDE_DIR" "$PROVIDERS_DIR"
for f in ccp.js ccm.js ccm-page.html cc-statusline.js cc-usage.js cc-lib.js; do
    cp "$CORE_DIR/$f" "$CLAUDE_DIR/$f"
done
echo '[1/4] ccp.js / ccm.js / cc-statusline.js / cc-usage.js 已写入 ~/.claude/'

# 2. providers 模板（已存在的不覆盖）
install_template() {
    local file="$1"
    if [ -f "$PROVIDERS_DIR/$file" ]; then
        echo "      providers/$file 已存在，跳过"
    else
        cat > "$PROVIDERS_DIR/$file"
        echo "      providers/$file 模板已创建"
    fi
}
install_template official.json <<'EOF'
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "",
    "ANTHROPIC_BASE_URL": "",
    "ANTHROPIC_MODEL": "",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME": "",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "",
    "API_TIMEOUT_MS": ""
  }
}
EOF
install_template glm.json <<'EOF'
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://open.bigmodel.cn/api/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "在这里填入你的GLM_APIKey",
    "ANTHROPIC_MODEL": "glm-5.3[1M]",
    "ANTHROPIC_DEFAULT_FABLE_MODEL": "glm-5.3[1M]",
    "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME": "glm-5.3",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "glm-5.3",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "glm-5.3",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "glm-5.3[1M]",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "glm-5.3",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.3[1M]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "glm-5.3",
    "API_TIMEOUT_MS": "3000000"
  }
}
EOF
echo '[2/4] providers 目录就绪'

# 3. shell 的 ccp 命令（幂等：先移除旧标记块再追加）
CC_BLOCK='
# >>> cc 多供应商启动器 >>>
# ccp           交互菜单选择 provider 后在当前终端启动 claude
# ccp <名称>    直接用 ~/.claude/providers/<名称>.json 启动（如 ccp glm）
# ccp default   不带 --settings，走当前全局默认配置
ccp() { node "$HOME/.claude/ccp.js" "$@"; }
# ccm — 打开供应商配置管理器（Web UI）
ccm() { node "$HOME/.claude/ccm.js" "$@"; }
# <<< cc 多供应商启动器 <<<'

strip_block() {
    # 多行标记块整体删除（perl -0777 滑过换行；macOS 自带 perl）
    perl -0777 -i -pe 's/# >>> cc 多供应商启动器 >>>.*?# <<< cc 多供应商启动器 <<<\n?//gs' "$1"
}

install_rc_block() {
    local rc="$1"
    strip_block "$rc"
    printf '%s\n' "$CC_BLOCK" >> "$rc"
}

want_bash=0
want_zsh=0
[ -f "$HOME/.bashrc" ] && want_bash=1
[ -f "$HOME/.zshrc" ] && want_zsh=1
case "${SHELL:-}" in
    *bash*) want_bash=1 ;;   # 包含匹配：Git Bash 的 SHELL 是 /bin/bash.exe
    *zsh*)  want_zsh=1 ;;
esac

if [ "$want_bash" -eq 1 ]; then
    touch "$HOME/.bashrc"
    install_rc_block "$HOME/.bashrc"
    # 登录 shell 默认不读 .bashrc，这里手动加载
    if [ ! -f "$HOME/.bash_profile" ]; then
        printf '[ -f ~/.bashrc ] && . ~/.bashrc\n' > "$HOME/.bash_profile"
    fi
    echo "[3/4] bash ccp 命令已装入 ~/.bashrc"
fi
if [ "$want_zsh" -eq 1 ]; then
    touch "$HOME/.zshrc"
    install_rc_block "$HOME/.zshrc"
    echo "[3/4] zsh ccp 命令已装入 ~/.zshrc"
fi
[ "$want_bash" -eq 0 ] && [ "$want_zsh" -eq 0 ] && echo '[3/4] 未识别到 bash/zsh，跳过（请手动在 shell 配置里加 ccp/ccm 函数）'

# 4. settings.json 的 statusLine（已有则跳过）
node -e '
const fs = require("fs");
const p = process.env.HOME + "/.claude/settings.json";
if (!fs.existsSync(p)) { console.log("[4/4] 未找到 ~/.claude/settings.json，跳过 statusLine"); process.exit(0); }
let j;
try { j = JSON.parse(fs.readFileSync(p, "utf8")); }
catch { console.log("[4/4] settings.json 解析失败，跳过 statusLine"); process.exit(0); }
if (j.statusLine) { console.log("[4/4] settings.json 已有 statusLine，跳过"); process.exit(0); }
j.statusLine = { type: "command", command: "node " + process.env.HOME + "/.claude/cc-statusline.js" };
fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
console.log("[4/4] settings.json 已加 statusLine");
'

# ============ 摘要 ============
echo ''
echo '安装完成。后续步骤：'
echo '  1. 运行 ccm 打开供应商管理器（浏览器页面），新增/编辑配置（或从旧机器拷贝 providers/*.json）'
echo '  2. 新开终端即可用 ccp / ccp glm 等'
if [ -d "$HOME/.cc-switch" ]; then
    echo '  3. 注意：检测到 cc-switch——它会整份重写 settings.json，请把 statusLine 段加进 cc-switch 的 "Claude 通用配置"，否则切换供应商后状态栏会消失'
fi
