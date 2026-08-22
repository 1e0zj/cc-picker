<#
cc-setup.ps1 — Claude Code 多供应商启动器 一键安装（自包含，无外部依赖）

在新机器上执行（需已安装 Claude Code，建议装好 PowerShell 7 与 Windows Terminal）：
    pwsh -ExecutionPolicy Bypass -File cc-setup.ps1

会安装：
  1. ~/.claude/cc-launch.ps1            启动器（右键菜单用）
  2. ~/.claude/cc-statusline.ps1        状态栏脚本
  3. ~/.claude/providers/*.json         供应商配置模板（已存在的不覆盖）
  4. 资源管理器右键菜单 "Claude Code（选模型）"
  5. pwsh / Git Bash 的 cc 命令（幂等，可重复执行）
  6. ~/.claude/settings.json 的 statusLine 键

不包含：各供应商的 token（模板留占位，从旧机器拷 providers/*.json 或手动填写）
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$claudeDir    = Join-Path $env:USERPROFILE '.claude'
$providersDir = Join-Path $claudeDir 'providers'

function Write-U8Bom([string]$Path, [string]$Content) {
    # UTF-8 with BOM：Windows PowerShell 5.1 与 pwsh 7 都能正确读中文
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($true))
}

# ============ 内嵌文件内容 ============

$managerPs1 = @'
<#
cc-manager.ps1 — Claude Code 供应商配置管理器（providers/*.json 的 GUI 管理）

用法:
  ccm                       弹出管理窗口（或直接 pwsh -File cc-manager.ps1）
  pwsh -File cc-manager.ps1 -List     控制台列出全部配置（无 GUI，供脚本/测试用）
#>
param([switch]$List)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$providersDir = Join-Path $env:USERPROFILE '.claude\providers'
New-Item -ItemType Directory -Force -Path $providersDir | Out-Null

# ---------- 数据层 ----------

function Get-Providers {
    # Where BaseName：跳过名为 ".json" 之类的空名文件（历史遗留会在列表里变成无名幽灵行）
    @(Get-ChildItem -LiteralPath $providersDir -Filter '*.json' -ErrorAction SilentlyContinue | Where-Object { $_.BaseName } | Sort-Object Name | ForEach-Object {
        $envObj = $null
        try { $envObj = (Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json).env } catch {}
        $token = if ($envObj) { [string]$envObj.ANTHROPIC_AUTH_TOKEN } else { '' }
        [pscustomobject]@{
            Name   = $_.BaseName
            Path   = $_.FullName
            Env    = $envObj
            Url    = if ($envObj) { [string]$envObj.ANTHROPIC_BASE_URL } else { '' }
            Token  = $token
            Masked = if ($token.Length -gt 10) { $token.Substring(0, 6) + '...' + $token.Substring($token.Length - 4) } elseif ($token) { $token } else { '(官方/空)' }
            Model  = if ($envObj) { [string]$envObj.ANTHROPIC_MODEL } else { '' }
        }
    })
}

function Save-Provider([string]$Name, [hashtable]$Env) {
    $path = Join-Path $providersDir ($Name + '.json')
    $json = @{ env = $Env } | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($path, $json, [Text.UTF8Encoding]::new($true))
    return $path
}

function Test-Provider($p) {
    # 对 {BASE_URL}/v1/messages 发一条 max_tokens=1 的最小请求；
    # 能拿到任何 HTTP 状态（含 401/400）即说明网络与端点通，附上错误摘要
    $url = $p.Url
    if ([string]::IsNullOrWhiteSpace($url)) { $url = 'https://api.anthropic.com' }
    $body = @{ model = $p.Model; max_tokens = 1; messages = @(@{ role = 'user'; content = 'hi' }) } | ConvertTo-Json -Depth 4
    $headers = @{
        'anthropic-version' = '2023-06-01'
        'x-api-key'         = $p.Token
        'authorization'     = 'Bearer ' + $p.Token
    }
    try {
        $resp = Invoke-WebRequest -Uri ($url.TrimEnd('/') + '/v1/messages') -Method Post -Headers $headers -Body $body -ContentType 'application/json' -TimeoutSec 20
        return "HTTP $([int]$resp.StatusCode) OK — 端点与鉴权均正常"
    } catch {
        $code = $null
        try { $code = [int]$_.Exception.Response.StatusCode } catch {}
        if ($code) {
            $detail = ''
            try {
                $stream = $_.ErrorDetails.Message
                if ($stream) { $detail = ($stream | ConvertFrom-Json).error.message }
            } catch {}
            return "HTTP $code — 端点可达" + $(if ($detail) { "（$detail）" } else { '' })
        }
        return "不可达：$($_.Exception.Message)"
    }
}

# ---------- -List 模式（无 GUI）----------

if ($List) {
    $ps = Get-Providers
    if (-not $ps) { Write-Output "（$providersDir 下没有配置）"; exit 0 }
    foreach ($p in $ps) {
        Write-Output ("{0,-16} {1,-45} {2,-14} {3}" -f $p.Name, $p.Url, $p.Masked, $p.Model)
    }
    exit 0
}

# ---------- 编辑/新增对话框 ----------

function Show-EditDialog($existing) {
    $isNew = $null -eq $existing
    $dlg = New-Object System.Windows.Forms.Form
    $dlg.Text            = if ($isNew) { '新增供应商' } else { "编辑 — $($existing.Name)" }
    $dlg.FormBorderStyle = 'FixedDialog'
    $dlg.MaximizeBox     = $false
    $dlg.StartPosition   = 'CenterParent'
    $dlg.ClientSize      = New-Object System.Drawing.Size(470, 470)
    # 主窗口是 TopMost，编辑框不置顶、不挂 owner 会被挡在主窗口后面
    $dlg.TopMost         = $true

    function Add-Label([string]$text, [int]$x, [int]$y) {
        $l = New-Object System.Windows.Forms.Label
        $l.Text = $text; $l.Location = New-Object System.Drawing.Point($x, $y); $l.AutoSize = $true
        $dlg.Controls.Add($l); return $l
    }
    function Add-Box([int]$x, [int]$y, [int]$w, [bool]$secret = $false) {
        $t = New-Object System.Windows.Forms.TextBox
        $t.Location = New-Object System.Drawing.Point($x, $y); $t.Size = New-Object System.Drawing.Size($w, 23)
        $dlg.Controls.Add($t); return $t
    }

    Add-Label '名称（英文，作为菜单/命令里的标识）' 14 14   | Out-Null
    $tbName = Add-Box 14 34 200
    if (-not $isNew) { $tbName.Text = $existing.Name }   # 预填现名，允许改名（保存时重命名文件）

    Add-Label '接口地址 ANTHROPIC_BASE_URL（官方留空）' 14 66 | Out-Null
    $tbUrl = Add-Box 14 86 440

    $presetOfficial = New-Object System.Windows.Forms.Button
    $presetOfficial.Text = '官方'; $presetOfficial.Location = New-Object System.Drawing.Point(14, 112); $presetOfficial.Size = New-Object System.Drawing.Size(60, 24)
    $presetGlm = New-Object System.Windows.Forms.Button
    $presetGlm.Text = 'GLM 预设'; $presetGlm.Location = New-Object System.Drawing.Point(80, 112); $presetGlm.Size = New-Object System.Drawing.Size(80, 24)
    $presetDs = New-Object System.Windows.Forms.Button
    $presetDs.Text = 'DeepSeek 预设'; $presetDs.Location = New-Object System.Drawing.Point(166, 112); $presetDs.Size = New-Object System.Drawing.Size(100, 24)
    $dlg.Controls.AddRange(@($presetOfficial, $presetGlm, $presetDs))

    Add-Label 'Token（ANTHROPIC_AUTH_TOKEN）' 14 146 | Out-Null
    $tbToken = Add-Box 14 166 440

    Add-Label '主模型 ANTHROPIC_MODEL' 14 198 | Out-Null
    $tbModel = Add-Box 14 218 440

    $grp = New-Object System.Windows.Forms.GroupBox
    $grp.Text = '高级：档位映射与超时（可留空）'; $grp.Location = New-Object System.Drawing.Point(14, 248); $grp.Size = New-Object System.Drawing.Size(440, 140)
    $dlg.Controls.Add($grp)

    function Add-Grp([string]$text, [int]$x, [int]$y) {
        $l = New-Object System.Windows.Forms.Label
        $l.Text = $text; $l.Location = New-Object System.Drawing.Point($x, $y); $l.AutoSize = $true
        $grp.Controls.Add($l); return $l
    }
    $tbHaiku = $null; $tbOpus = $null; $tbSonnet = $null; $tbTimeout = $null
    Add-Grp 'HAIKU 映射'    10 24  | Out-Null; $tbHaiku   = New-Object System.Windows.Forms.TextBox; $tbHaiku.Location   = New-Object System.Drawing.Point(110, 20);  $tbHaiku.Size   = New-Object System.Drawing.Size(300, 23)
    Add-Grp 'OPUS 映射'     10 56  | Out-Null; $tbOpus    = New-Object System.Windows.Forms.TextBox; $tbOpus.Location    = New-Object System.Drawing.Point(110, 52);  $tbOpus.Size    = New-Object System.Drawing.Size(300, 23)
    Add-Grp 'SONNET 映射'   10 88  | Out-Null; $tbSonnet  = New-Object System.Windows.Forms.TextBox; $tbSonnet.Location  = New-Object System.Drawing.Point(110, 84);  $tbSonnet.Size  = New-Object System.Drawing.Size(300, 23)
    Add-Grp 'API_TIMEOUT_MS' 10 120 | Out-Null; $tbTimeout = New-Object System.Windows.Forms.TextBox; $tbTimeout.Location = New-Object System.Drawing.Point(110, 116); $tbTimeout.Size = New-Object System.Drawing.Size(120, 23)
    $grp.Controls.AddRange(@($tbHaiku, $tbOpus, $tbSonnet, $tbTimeout))

    $btnOk = New-Object System.Windows.Forms.Button
    $btnOk.Text = '保存'; $btnOk.Location = New-Object System.Drawing.Point(280, 420); $btnOk.Size = New-Object System.Drawing.Size(80, 30)
    $btnOk.DialogResult = 'OK'
    $btnCancel = New-Object System.Windows.Forms.Button
    $btnCancel.Text = '取消'; $btnCancel.Location = New-Object System.Drawing.Point(370, 420); $btnCancel.Size = New-Object System.Drawing.Size(80, 30)
    $btnCancel.DialogResult = 'Cancel'
    $dlg.Controls.AddRange(@($btnOk, $btnCancel))
    $dlg.AcceptButton = $btnOk; $dlg.CancelButton = $btnCancel

    # 预设
    $presetOfficial.Add_Click({
        $tbUrl.Text = ''; $tbModel.Text = ''
        $tbHaiku.Text = ''; $tbOpus.Text = ''; $tbSonnet.Text = ''; $tbTimeout.Text = ''
    })
    $presetGlm.Add_Click({
        $tbUrl.Text = 'https://open.bigmodel.cn/api/anthropic'
        $tbModel.Text = 'glm-5.3[1M]'; $tbHaiku.Text = 'glm-5.3'; $tbOpus.Text = 'glm-5.3[1M]'; $tbSonnet.Text = 'glm-5.3[1M]'
        $tbTimeout.Text = '3000000'; $tbToken.Focus()
    })
    $presetDs.Add_Click({
        $tbUrl.Text = 'https://api.deepseek.com/anthropic'
        $tbModel.Text = 'deepseek-v4-pro'; $tbHaiku.Text = 'deepseek-v4-flash'; $tbOpus.Text = 'deepseek-v4-pro[1M]'; $tbSonnet.Text = 'deepseek-v4-pro'
        $tbTimeout.Text = '3000000'; $tbToken.Focus()
    })

    # 编辑时预填（保留原始 env 的所有键，保存时仅覆盖表单里的键）
    $script:rawEnv = @{}
    if (-not $isNew -and $existing.Env) {
        foreach ($prop in $existing.Env.PSObject.Properties) { $script:rawEnv[$prop.Name] = [string]$prop.Value }
        $tbUrl.Text     = [string]$existing.Env.ANTHROPIC_BASE_URL
        $tbToken.Text   = [string]$existing.Env.ANTHROPIC_AUTH_TOKEN
        $tbModel.Text   = [string]$existing.Env.ANTHROPIC_MODEL
        $tbHaiku.Text   = [string]$existing.Env.ANTHROPIC_DEFAULT_HAIKU_MODEL
        $tbOpus.Text    = [string]$existing.Env.ANTHROPIC_DEFAULT_OPUS_MODEL
        $tbSonnet.Text  = [string]$existing.Env.ANTHROPIC_DEFAULT_SONNET_MODEL
        $tbTimeout.Text = [string]$existing.Env.API_TIMEOUT_MS
    }

    if ($dlg.ShowDialog($form) -ne [System.Windows.Forms.DialogResult]::OK) { return $null }

    $name = $tbName.Text.Trim()
    if ($name -notmatch '^[A-Za-z0-9_-]+$') {
        [void][System.Windows.Forms.MessageBox]::Show($dlg, '名称只能用英文、数字、-、_（方便命令行 cc <名称> 使用）', '提示')
        return $null
    }
    $oldName = if ($isNew) { $null } else { $existing.Name }
    if ($name -ne $oldName -and (Test-Path -LiteralPath (Join-Path $providersDir ($name + '.json')))) {
        [void][System.Windows.Forms.MessageBox]::Show($dlg, "已存在同名配置: $name", '提示')
        return $null
    }

    $env = $script:rawEnv.Clone()
    $env['ANTHROPIC_BASE_URL']                = $tbUrl.Text.Trim()
    $env['ANTHROPIC_AUTH_TOKEN']              = $tbToken.Text.Trim()
    $env['ANTHROPIC_MODEL']                   = $tbModel.Text.Trim()
    $env['ANTHROPIC_DEFAULT_HAIKU_MODEL']     = $tbHaiku.Text.Trim()
    $env['ANTHROPIC_DEFAULT_OPUS_MODEL']      = $tbOpus.Text.Trim()
    $env['ANTHROPIC_DEFAULT_SONNET_MODEL']    = $tbSonnet.Text.Trim()
    $env['ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME']     = $tbHaiku.Text.Trim() -replace '\[.*$', ''
    $env['ANTHROPIC_DEFAULT_OPUS_MODEL_NAME']      = $tbOpus.Text.Trim() -replace '\[.*$', ''
    $env['ANTHROPIC_DEFAULT_SONNET_MODEL_NAME']    = $tbSonnet.Text.Trim() -replace '\[.*$', ''
    $env['API_TIMEOUT_MS']                    = $tbTimeout.Text.Trim()

    return @{ Name = $name; Env = $env; OldName = $oldName }
}

# ---------- 主窗口 ----------

$form = New-Object System.Windows.Forms.Form
$form.Text          = 'Claude Code 供应商管理'
$form.StartPosition = 'CenterScreen'
$form.ClientSize    = New-Object System.Drawing.Size(700, 420)
$form.TopMost       = $true

# 注意：变量名不能用 $list——与顶部 param([switch]$List) 同名（PS 变量名不区分大小写），
# 会被当作 switch 参数赋值而报 SwitchParameter 转换错误
$listView = New-Object System.Windows.Forms.ListView
$listView.View = 'Details'; $listView.FullRowSelect = $true; $listView.HideSelection = $false
$listView.Location = New-Object System.Drawing.Point(12, 12)
$listView.Size     = New-Object System.Drawing.Size(676, 330)
[void]$listView.Columns.Add('名称', 130)
[void]$listView.Columns.Add('接口地址', 240)
[void]$listView.Columns.Add('Token', 150)
[void]$listView.Columns.Add('主模型', 150)
$form.Controls.Add($listView)

$status = New-Object System.Windows.Forms.StatusStrip
$statusLabel = New-Object System.Windows.Forms.ToolStripStatusLabel
$statusLabel.Text = "目录: $providersDir   |   双击行编辑；启动用 cc / 右键菜单"
[void]$status.Items.Add($statusLabel)
$form.Controls.Add($status)

function New-Btn([string]$text, [int]$x, [int]$w) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text; $b.Location = New-Object System.Drawing.Point($x, 352); $b.Size = New-Object System.Drawing.Size($w, 30)
    $form.Controls.Add($b); return $b
}
$btnAdd    = New-Btn '新增'          12  70
$btnEdit   = New-Btn '编辑'          88  70
$btnDel    = New-Btn '删除'          164 70
$btnTest   = New-Btn '测试连通'      260 90
$btnFolder = New-Btn '打开目录'      358 90
$btnClose  = New-Btn '关闭'          616 70

function Refresh-List {
    $listView.Items.Clear()
    foreach ($p in (Get-Providers)) {
        $item = New-Object System.Windows.Forms.ListViewItem($p.Name)
        [void]$item.SubItems.Add($p.Url)
        [void]$item.SubItems.Add($p.Masked)
        [void]$item.SubItems.Add($p.Model)
        [void]$listView.Items.Add($item)
    }
}

$btnAdd.Add_Click({
    $r = Show-EditDialog $null
    if ($r) { Save-Provider $r.Name $r.Env | Out-Null; Refresh-List }
})
$btnEdit.Add_Click({
    if ($listView.SelectedItems.Count -eq 0) { return }
    $sel = (Get-Providers) | Where-Object { $_.Name -eq $listView.SelectedItems[0].Text }
    if ($sel) {
        $r = Show-EditDialog $sel
        if ($r) {
            # 改名 = 删旧文件，Save-Provider 再按新名写入
            if ($r.OldName -and $r.OldName -ne $r.Name) {
                Remove-Item -LiteralPath (Join-Path $providersDir ($r.OldName + '.json')) -Force
            }
            Save-Provider $r.Name $r.Env | Out-Null
            Refresh-List
        }
    }
})
$listView.Add_DoubleClick({ $btnEdit.PerformClick() })
$btnDel.Add_Click({
    if ($listView.SelectedItems.Count -eq 0) { return }
    $name = $listView.SelectedItems[0].Text
    $ans = [System.Windows.Forms.MessageBox]::Show($form, "确定删除 $name ？", '确认', 'YesNo', 'Warning')
    if ($ans -eq 'Yes') { Remove-Item -LiteralPath (Join-Path $providersDir ($name + '.json')) -Force; Refresh-List }
})
$btnTest.Add_Click({
    if ($listView.SelectedItems.Count -eq 0) { return }
    $sel = (Get-Providers) | Where-Object { $_.Name -eq $listView.SelectedItems[0].Text }
    if (-not $sel) { return }
    $statusLabel.Text = "正在测试 $($sel.Name) ..."
    $form.Refresh()
    $statusLabel.Text = "$($sel.Name): $(Test-Provider $sel)"
})
$btnFolder.Add_Click({ Start-Process explorer.exe "/select,`"$providersDir`"" })
$btnClose.Add_Click({ $form.Close() })

Refresh-List
[void]$form.ShowDialog()
'@

$launchPs1 = @'
<#
Claude Code 多供应商启动器

用法:
  cc-launch.ps1                          在当前目录弹出选择窗
  cc-launch.ps1 -Directory "C:\proj"     指定目录（资源管理器右键菜单用 %V 调用）
  cc-launch.ps1 -Pick glm                跳过弹窗，直接用指定 provider（default 或 providers 下的文件名）
#>
param(
    [string]$Directory,
    [string]$Pick
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Show-Msg([string]$Text, [string]$Title = 'Claude Code 启动器') {
    [void][System.Windows.Forms.MessageBox]::Show($Text, $Title)
}

# ---- 解析目标目录 ----
if (-not $Directory) { $Directory = (Get-Location).Path }

# 兼容右键菜单 %V/%1 传参的引号错位：盘根目录 "C:\" 里的 \" 被 CLI 解析为转义引号，
# 实际收到 'C:"'；统一剥掉首尾引号，盘符裸路径（C:）补回 '\'
$Directory = $Directory.Trim('"')
if ($Directory -match '^[A-Za-z]:$') { $Directory += '\' }

if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
    Show-Msg "目录不存在: $Directory"
    exit 1
}
$Directory = (Get-Item -LiteralPath $Directory).FullName

# ---- 扫描 providers（跳过 ".json" 之类的空名文件）----
$providersDir = Join-Path $env:USERPROFILE '.claude\providers'
$providers = @()
if (Test-Path -LiteralPath $providersDir) {
    $providers = @(Get-ChildItem -LiteralPath $providersDir -Filter '*.json' | Where-Object { $_.BaseName } | Sort-Object Name)
}

# ---- 弹窗选择 ----
$defaultLabel = 'default（cc-switch 当前全局配置）'
$choice = $Pick
if (-not $choice) {
    if ($providers.Count -eq 0) {
        Show-Msg "未找到任何配置文件，请先创建: $providersDir\<名称>.json"
        exit 1
    }

    $form = New-Object System.Windows.Forms.Form
    $form.Text            = 'Claude Code — 选择模型'
    $form.FormBorderStyle = 'FixedDialog'
    $form.MaximizeBox     = $false
    $form.MinimizeBox     = $false
    $form.StartPosition   = 'CenterScreen'
    $form.TopMost         = $true
    $form.Size            = New-Object System.Drawing.Size(360, 280)

    $list = New-Object System.Windows.Forms.ListBox
    $list.Font     = New-Object System.Drawing.Font('Segoe UI', 11)
    $list.Location = New-Object System.Drawing.Point(14, 14)
    $list.Size     = New-Object System.Drawing.Size(316, 170)
    [void]$list.Items.Add($defaultLabel)
    foreach ($p in $providers) { [void]$list.Items.Add($p.BaseName) }
    $list.SelectedIndex = 0

    $ok = New-Object System.Windows.Forms.Button
    $ok.Text     = '启动'
    $ok.DialogResult = 'OK'
    $ok.Location = New-Object System.Drawing.Point(160, 200)
    $ok.Size     = New-Object System.Drawing.Size(80, 30)

    $cancel = New-Object System.Windows.Forms.Button
    $cancel.Text     = '取消'
    $cancel.DialogResult = 'Cancel'
    $cancel.Location = New-Object System.Drawing.Point(250, 200)
    $cancel.Size     = New-Object System.Drawing.Size(80, 30)

    $form.AcceptButton = $ok
    $form.CancelButton = $cancel
    $form.Controls.AddRange(@($list, $ok, $cancel))

    if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
    $choice = [string]$list.SelectedItem
    if ($choice -eq $defaultLabel) { $choice = 'default' }
}

# ---- 定位 claude ----
$claude = $null
try { $claude = (Get-Command claude -ErrorAction Stop).Source } catch {}
if (-not $claude) {
    $cand = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
    if (Test-Path -LiteralPath $cand) { $claude = $cand }
}
if (-not $claude) {
    Show-Msg "找不到 claude 可执行文件（PATH 和 ~\.local\bin\claude.exe 都没有）"
    exit 1
}

# ---- 解析 settings 文件 ----
$settingsFile = $null
if ($choice -ne 'default') {
    $settingsFile = Join-Path $providersDir ($choice + '.json')
    if (-not (Test-Path -LiteralPath $settingsFile)) {
        Show-Msg "配置不存在: $settingsFile"
        exit 1
    }
}

# ---- 拼命令行并启动（新 tab 用 pwsh，路径用单引号避免引号转义问题）----
if ($settingsFile) {
    $inner = "& '{0}' --settings '{1}'" -f $claude, $settingsFile
    $title = 'claude [{0}]' -f $choice
} else {
    $inner = "& '{0}'" -f $claude
    $title = 'claude'
}

# ---- tab 颜色：按厂商归组（与状态栏配色一致）----
# glm / glm-work = 青，deepseek / deepseek-work = 蓝，official = 绿，default = 灰，未知厂商 = 黄
$palette = @{ 'default' = '#888888'; 'glm' = '#00B8A9'; 'glm-work' = '#00B8A9'; 'deepseek' = '#4D6FFF'; 'deepseek-work' = '#4D6FFF'; 'official' = '#2ECC71' }
$tabColor = $palette[$choice]
if (-not $tabColor) { $tabColor = '#F1C40F' }

$wt = Get-Command wt.exe -ErrorAction SilentlyContinue
if ($wt) {
    & $wt.Source new-tab --title $title --tabColor $tabColor -d "$Directory" pwsh -NoExit -Command $inner
} else {
    Start-Process pwsh.exe -WorkingDirectory $Directory -ArgumentList '-NoExit', '-Command', $inner
}
'@

$usagePs1 = @'
<#
cc-usage.ps1 — 供应商限额/余额查询（结果写缓存，供状态栏显示；由状态栏异步调起）

数据源（按 ANTHROPIC_BASE_URL 识别）：
  GLM 套餐（bigmodel.cn / z.ai）   GET {host}/api/monitor/usage/quota/limit（Authorization 用裸 token，不加 Bearer）
                                    data.limits[] 里 type=TOKENS_LIMIT 的条目：unit=3 → 5小时窗口，unit=6 → 周窗口
                                    （percentage = 已用百分比，nextResetTime = 毫秒时间戳）
  DeepSeek                          GET https://api.deepseek.com/user/balance（账户余额，CNY）
  官方/其他                         不查询

用法: pwsh -NoProfile -File cc-usage.ps1 [provider 名 ...]    # 缺省刷新全部
缓存: ~/.claude/cc-usage-cache.json   （格式 { <名>: { fetchedAt, tiers:[{kind,pct,resetMs}] | balance | error } }）
#>
param([string[]]$Names)

$ErrorActionPreference = 'SilentlyContinue'
$providersDir = Join-Path $env:USERPROFILE '.claude\providers'
$cacheFile    = Join-Path $env:USERPROFILE '.claude\cc-usage-cache.json'
$now = (Get-Date).ToUniversalTime().ToString('o')

function Get-GlmUsage([string]$ApiHost, [string]$Token) {
    try {
        $resp = Invoke-RestMethod -Uri ($ApiHost + '/api/monitor/usage/quota/limit') -Headers @{ Authorization = $Token } -TimeoutSec 15
        if (-not $resp.success -or -not $resp.data) {
            return [pscustomobject]@{ fetchedAt = $now; error = "API: $($resp.msg)" }
        }
        $items = @()
        foreach ($lim in @($resp.data.limits)) {
            # 只解析 TOKENS_LIMIT/CREDIT_LIMIT（5h 与周窗口）；TIME_LIMIT 是附加产品
            # （搜索/网页阅读等）的月度量，不是模型调用限额，不显示
            if (@('TOKENS_LIMIT', 'CREDIT_LIMIT') -notcontains [string]$lim.type) { continue }
            # unit 分类；缺失时兜底：无 nextResetTime 的归 5h（周期耗尽态可能无重置时间），其余归周
            $kind = $null
            if ([int]$lim.unit -eq 3) { $kind = 'h5' }
            elseif ([int]$lim.unit -eq 6) { $kind = 'week' }
            elseif (-not $lim.nextResetTime) { $kind = 'h5' } else { $kind = 'week' }
            $items += [pscustomobject]@{ kind = $kind; pct = [int][double]$lim.percentage }
        }
        $tiers = @()
        foreach ($k in 'h5', 'week') {
            $t = $items | Where-Object { $_.kind -eq $k } | Select-Object -First 1
            if ($t) { $tiers += $t }
        }
        return [pscustomobject]@{ fetchedAt = $now; tiers = $tiers }
    } catch {
        return [pscustomobject]@{ fetchedAt = $now; error = [string]$_.Exception.Message }
    }
}

# 读旧缓存（保留本次未刷新的条目）
$cacheMap = @{}
if (Test-Path -LiteralPath $cacheFile) {
    try {
        $old = Get-Content -LiteralPath $cacheFile -Raw | ConvertFrom-Json
        foreach ($p in $old.PSObject.Properties) { $cacheMap[$p.Name] = $p.Value }
    } catch {}
}

foreach ($f in @(Get-ChildItem -LiteralPath $providersDir -Filter '*.json' | Where-Object { $_.BaseName })) {
    $name = $f.BaseName
    if ($Names -and $Names -notcontains $name) { continue }
    try { $envObj = (Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json).env } catch { continue }
    $token = [string]$envObj.ANTHROPIC_AUTH_TOKEN
    $url   = [string]$envObj.ANTHROPIC_BASE_URL
    if (-not $token -or $token -match '在这里填入') { continue }   # 未填 token 的模板

    $entry = $null
    if ($url -match 'bigmodel\.cn') {
        $entry = Get-GlmUsage 'https://open.bigmodel.cn' $token
    } elseif ($url -match 'api\.z\.ai') {
        $entry = Get-GlmUsage 'https://api.z.ai' $token
    } elseif ($url -match 'api\.deepseek\.com') {
        try {
            $bal = Invoke-RestMethod -Uri 'https://api.deepseek.com/user/balance' -Headers @{ Authorization = 'Bearer ' + $token } -TimeoutSec 15
            $cny = @($bal.balance_infos) | Where-Object { $_.currency -eq 'CNY' } | Select-Object -First 1
            $entry = [pscustomobject]@{ fetchedAt = $now; balance = [string]$cny.total_balance }
        } catch {
            $entry = [pscustomobject]@{ fetchedAt = $now; error = [string]$_.Exception.Message }
        }
    }
    if ($entry) { $cacheMap[$name] = $entry }
}

$out = [ordered]@{}
foreach ($k in ($cacheMap.Keys | Sort-Object)) { $out[$k] = $cacheMap[$k] }
[IO.File]::WriteAllText($cacheFile, ($out | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
'@

$statuslinePs1 = @'
# cc-statusline.ps1 — Claude Code 状态栏
# 显示：[供应商账号] 模型 · 目录 · 上下文用量%
# 识别原理：用当前进程 env 里的 ANTHROPIC_AUTH_TOKEN 匹配 ~/.claude/providers/*.json，
# 匹配不到时按 ANTHROPIC_BASE_URL 判断（空 = 官方）。default 启动同样能识别。

# 编码统一 UTF-8：Claude Code 按 UTF-8 读写本进程的 stdin/stdout，
# pwsh 默认跟随系统代码页（GBK），中文目录名与 "·" 分隔符会变乱码
$data = (New-Object IO.StreamReader([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false))).ReadToEnd() | ConvertFrom-Json

$model   = if ($data.model.display_name) { $data.model.display_name } else { '?' }
$dirName = Split-Path -Leaf ($data.workspace.current_dir)
if (-not $dirName) { $dirName = $data.workspace.current_dir }
$pct = 0
if ($null -ne $data.context_window.used_percentage) { $pct = [int]$data.context_window.used_percentage }

# ---- 识别供应商账号 ----
$token   = $env:ANTHROPIC_AUTH_TOKEN
$baseUrl = $env:ANTHROPIC_BASE_URL
$prov = $null
$pdir = Join-Path $env:USERPROFILE '.claude\providers'
if ($token) {
    foreach ($f in @(Get-ChildItem -LiteralPath $pdir -Filter '*.json' -ErrorAction SilentlyContinue)) {
        try { $e = (Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json).env } catch { continue }
        if ($e.ANTHROPIC_AUTH_TOKEN -and $e.ANTHROPIC_AUTH_TOKEN -eq $token) { $prov = $f.BaseName; break }
    }
}
if (-not $prov) {
    if ([string]::IsNullOrWhiteSpace($baseUrl)) { $prov = 'official' }
    else { $prov = ($baseUrl -replace '^https?://', '') -split '/' | Select-Object -First 1 }
}

# ---- 配色：与 wt tab 颜色完全一致，按厂商归组（glm 系=青 / deepseek 系=蓝 / official=绿 / 其他=黄）----
$esc  = [char]27
$cEnd = "$esc[0m"
function Ansi([string]$Hex) {
    $r = [Convert]::ToInt32($Hex.Substring(1, 2), 16)
    $g = [Convert]::ToInt32($Hex.Substring(3, 2), 16)
    $b = [Convert]::ToInt32($Hex.Substring(5, 2), 16)
    return "$esc[38;2;$r;$g;${b}m"
}
$provColor = if ($prov -eq 'official') { Ansi '#2ECC71' }
             elseif ($prov -like 'glm*') { Ansi '#00B8A9' }
             elseif ($prov -like 'deepseek*') { Ansi '#4D6FFF' }
             else { Ansi '#F1C40F' }
$pctColor = if ($pct -ge 80) { Ansi '#E74C3C' } elseif ($pct -ge 50) { Ansi '#F1C40F' } else { Ansi '#2ECC71' }
function PctColor([int]$v) { if ($v -ge 80) { Ansi '#E74C3C' } elseif ($v -ge 50) { Ansi '#F1C40F' } else { Ansi '#2ECC71' } }

# ---- 限额/余额 ----
# 官方订阅：stdin 的 rate_limits 直接可用（Pro/Max 才有；API key 供应商无此字段）
# GLM/DeepSeek：读 cc-usage.ps1 写的缓存；超过 10 分钟异步刷新（不阻塞状态栏），本次先用旧值
function Update-UsageAsync([string]$Prov) {
    # 防抖：2 分钟内已触发过就不再起进程
    $lockFile = Join-Path $env:USERPROFILE '.claude\cc-usage.last'
    $last = [datetime]::MinValue
    if (Test-Path -LiteralPath $lockFile) { try { $last = [datetime](Get-Content -LiteralPath $lockFile -Raw) } catch {} }
    if (((Get-Date) - $last).TotalSeconds -lt 120) { return }
    try { [IO.File]::WriteAllText($lockFile, (Get-Date).ToString('o')) } catch {}
    Start-Process -WindowStyle Hidden pwsh -ArgumentList '-NoProfile', '-File', (Join-Path $env:USERPROFILE '.claude\cc-usage.ps1'), $Prov
}

$usageSeg = ''
if ($data.rate_limits) {
    $rl = $data.rate_limits
    if ($null -ne $rl.five_hour.used_percentage)  { $p = [int]$rl.five_hour.used_percentage;  $usageSeg += " · 5h $(PctColor $p)$p%$cEnd" }
    if ($null -ne $rl.seven_day.used_percentage) { $p = [int]$rl.seven_day.used_percentage; $usageSeg += " · 周 $(PctColor $p)$p%$cEnd" }
} elseif ($prov -ne 'official') {
    $cacheFile = Join-Path $env:USERPROFILE '.claude\cc-usage-cache.json'
    $ue = $null
    if (Test-Path -LiteralPath $cacheFile) {
        try { $ue = (Get-Content -LiteralPath $cacheFile -Raw | ConvertFrom-Json).($prov) } catch {}
    }
    if ($ue -and -not $ue.error) {
        if (((Get-Date) - [datetime]$ue.fetchedAt).TotalMinutes -gt 10) { Update-UsageAsync $prov }
        foreach ($t in @($ue.tiers)) {
            $p = [int]$t.pct
            if ($t.kind -eq 'h5')   { $usageSeg += " · 5h $(PctColor $p)$p%$cEnd" }
            if ($t.kind -eq 'week') { $usageSeg += " · 周 $(PctColor $p)$p%$cEnd" }
        }
        if ($ue.balance) { $usageSeg += " · ¥$($ue.balance)" }
    } elseif (-not $ue) {
        Update-UsageAsync $prov   # 首次：先触发查询，下一轮状态栏就有数据
    }
}

# ---- 布局：ctx 留在左侧，限额推到行右端（免得两类百分比混在一起）----
# Claude Code 会传 COLUMNS 环境变量；按可见宽度填充（ANSI 色码计 0 列，CJK 计 2 列）
function Get-VisibleWidth([string]$s) {
    # ·(U+00B7) 在中文字体下常按全角渲染，保守计 2 列——宁可右边多留空隙也不能溢出截断
    $w = 0
    foreach ($ch in ($s -replace "$esc\[[0-9;]*m", '').ToCharArray()) {
        $c = [int]$ch
        if ($c -ge 0x2E80 -or $c -eq 0xB7) { $w += 2 } else { $w += 1 }
    }
    return $w
}

$left  = "$provColor[$prov]$cEnd $model · $dirName · ctx $pctColor$pct%$cEnd"
$right = $usageSeg.TrimStart(' ·')
$out = if ($right) { "$left  $right" } else { $left }
$cols = 0
if ("" + $env:COLUMNS -match '^\d+$') { $cols = [int]$env:COLUMNS }
if ($right -and $cols -ge 60) {
    $pad = $cols - (Get-VisibleWidth $left) - (Get-VisibleWidth $right) - 2
    if ($pad -ge 2) { $out = $left + (' ' * $pad) + $right }
}

try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new() } catch {}
[Console]::Out.Write($out)
'@

$bashCc = @'
# >>> cc 多供应商启动器 >>>
# cc            交互菜单选择 provider 后在当前终端启动 claude
# cc <名称>     直接用 ~/.claude/providers/<名称>.json 启动（如 cc glm）
# cc default    不带 --settings，走 cc-switch 当前全局配置
cc() {
  local pdir="$HOME/.claude/providers"
  local sel="$1"
  local f i n name

  if [ -n "$sel" ]; then
    if [ "$sel" = "default" ]; then
      claude
      return
    fi
    f="$pdir/$sel.json"
    if [ ! -f "$f" ]; then
      echo "cc: 配置不存在: $f" >&2
      return 1
    fi
    claude --settings "$f"
    return
  fi

  local -a files=()
  for f in "$pdir"/*.json; do
    [ -e "$f" ] && [ "$(basename "$f" .json)" ] && files+=("$f")
  done
  if [ ${#files[@]} -eq 0 ]; then
    echo "cc: 未找到 $pdir/*.json" >&2
    return 1
  fi

  echo "选择要使用的模型配置:"
  echo "  0) default（cc-switch 当前全局配置）"
  i=1
  for f in "${files[@]}"; do
    name="$(basename "$f" .json)"
    printf '  %d) %s\n' "$i" "$name"
    i=$((i + 1))
  done
  read -rp "输入编号 [1]: " n
  n=${n:-1}
  if [ "$n" = "0" ]; then
    claude
    return
  fi
  if ! [[ "$n" =~ ^[0-9]+$ ]] || [ "$n" -lt 1 ] || [ "$n" -gt ${#files[@]} ]; then
    echo "cc: 无效选择: $n" >&2
    return 1
  fi
  claude --settings "${files[n - 1]}"
}

# ccm — 打开供应商配置管理器（GUI）
ccm() { pwsh -NoProfile -File "$HOME/.claude/cc-manager.ps1" "$@"; }
# <<< cc 多供应商启动器 <<<
'@

$pwshCc = @'
# >>> cc 多供应商启动器 >>>
# cc            交互菜单选择 provider 后在当前终端启动 claude
# cc <名称>     直接用 ~/.claude/providers/<名称>.json 启动（如 cc glm）
# cc default    不带 --settings，走 cc-switch 当前全局配置
function cc {
    param([string]$Pick)
    $providersDir = Join-Path $env:USERPROFILE '.claude\providers'

    if ($Pick) {
        if ($Pick -eq 'default') { & claude; return }
        $f = Join-Path $providersDir ($Pick + '.json')
        if (-not (Test-Path -LiteralPath $f)) { Write-Error "配置不存在: $f"; return }
        & claude --settings $f
        return
    }

    $files = @(Get-ChildItem -LiteralPath $providersDir -Filter '*.json' -ErrorAction SilentlyContinue | Where-Object { $_.BaseName } | Sort-Object Name)
    if ($files.Count -eq 0) { Write-Error "未找到 $providersDir\*.json"; return }

    Write-Host '选择要使用的模型配置:' -ForegroundColor Cyan
    Write-Host '  0) default（cc-switch 当前全局配置）'
    for ($i = 0; $i -lt $files.Count; $i++) {
        Write-Host ('  {0}) {1}' -f ($i + 1), $files[$i].BaseName)
    }
    $n = Read-Host '输入编号 [1]'
    if (-not $n) { $n = '1' }
    if ($n -eq '0') { & claude; return }
    if ($n -notmatch '^\d+$' -or [int]$n -lt 1 -or [int]$n -gt $files.Count) {
        Write-Error "无效选择: $n"
        return
    }
    & claude --settings $files[[int]$n - 1].FullName
}

# ccm — 打开供应商配置管理器（GUI）
function ccm { pwsh -NoProfile -File (Join-Path $env:USERPROFILE '.claude\cc-manager.ps1') @args }
# <<< cc 多供应商启动器 <<<
'@

$officialJson = @'
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
'@

$glmJson = @'
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
'@

# ============ 安装 ============

Write-Host '== Claude Code 多供应商启动器 安装 ==' -ForegroundColor Cyan

# 0. 前置检查
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Warning '未在 PATH 找到 claude 命令——请先安装 Claude Code，否则右键菜单无法启动'
}
$pwshExe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $pwshExe) { $pwshExe = (Get-Command powershell).Source }

# 1. 目录与核心脚本
New-Item -ItemType Directory -Force -Path $claudeDir, $providersDir | Out-Null
Write-U8Bom (Join-Path $claudeDir 'cc-launch.ps1')     $launchPs1
Write-U8Bom (Join-Path $claudeDir 'cc-statusline.ps1') $statuslinePs1
Write-U8Bom (Join-Path $claudeDir 'cc-manager.ps1')    $managerPs1
Write-U8Bom (Join-Path $claudeDir 'cc-usage.ps1')      $usagePs1
Write-Host '[1/6] cc-launch.ps1 / cc-statusline.ps1 / cc-manager.ps1 / cc-usage.ps1 已写入'

# 2. providers 模板（已存在的不覆盖）
foreach ($pair in @(@('official.json', $officialJson), @('glm.json', $glmJson))) {
    $p = Join-Path $providersDir $pair[0]
    if (Test-Path -LiteralPath $p) {
        Write-Host "      providers/$($pair[0]) 已存在，跳过"
    } else {
        Write-U8Bom $p $pair[1]
        Write-Host "      providers/$($pair[0]) 模板已创建"
    }
}
Write-Host '[2/6] providers 目录就绪'

# 3. 右键菜单（动态路径）
$launchPath = Join-Path $claudeDir 'cc-launch.ps1'
$cmdBg  = '"{0}" -NoProfile -WindowStyle Hidden -File "{1}" -Directory "%V"' -f $pwshExe, $launchPath
$cmdDir = '"{0}" -NoProfile -WindowStyle Hidden -File "{1}" -Directory "%1"' -f $pwshExe, $launchPath
foreach ($root in 'HKCU:\Software\Classes\Directory\Background\shell\ClaudePicker', 'HKCU:\Software\Classes\Directory\shell\ClaudePicker') {
    New-Item -Path $root -Force | Out-Null
    Set-ItemProperty -Path $root -Name '(Default)' -Value 'Claude Code（选模型）'
    $icon = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
    if (Test-Path -LiteralPath $icon) { Set-ItemProperty -Path $root -Name 'Icon' -Value $icon }
    New-Item -Path (Join-Path $root 'command') -Force | Out-Null
    $c = if ($root -like '*Background*') { $cmdBg } else { $cmdDir }
    Set-ItemProperty -Path (Join-Path $root 'command') -Name '(Default)' -Value $c
}
Write-Host '[3/6] 资源管理器右键菜单已注册'

# 4. pwsh 的 cc 函数（幂等：先移除旧标记块再追加）
$profileDir = Split-Path $PROFILE -Parent
New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
$existing = ''
if (Test-Path -LiteralPath $PROFILE) { $existing = [string](Get-Content -LiteralPath $PROFILE -Raw) }
$existing = $existing -replace '(?s)# >>> cc 多供应商启动器 >>>.*?# <<< cc 多供应商启动器 <<<\r?\n?', ''
Write-U8Bom $PROFILE ($existing.TrimEnd() + "`r`n`r`n" + $pwshCc.Trim() + "`r`n")
Write-Host "[4/6] pwsh cc 命令已装入 $PROFILE"

# 5. Git Bash 的 cc 函数（检测到 Git 才装）
$bashrc = Join-Path $env:USERPROFILE '.bashrc'
$bashProfile = Join-Path $env:USERPROFILE '.bash_profile'
$hasGit = (Test-Path 'C:\Program Files\Git') -or (Get-Command bash.exe -ErrorAction SilentlyContinue)
if ($hasGit) {
    $existingBash = if (Test-Path -LiteralPath $bashrc) { [IO.File]::ReadAllText($bashrc) } else { '' }
    $existingBash = $existingBash -replace '(?s)# >>> cc 多供应商启动器 >>>.*?# <<< cc 多供应商启动器 <<<\r?\n?', ''
    [IO.File]::WriteAllText($bashrc, $existingBash.TrimEnd() + "`n`n" + $bashCc.Trim() + "`n", [Text.UTF8Encoding]::new($false))
    if (-not (Test-Path -LiteralPath $bashProfile)) {
        [IO.File]::WriteAllText($bashProfile, "# Git Bash 登录 shell 默认不读 .bashrc，这里手动加载`n[ -f ~/.bashrc ] && . ~/.bashrc`n", [Text.UTF8Encoding]::new($false))
    }
    Write-Host '[5/6] Git Bash cc 命令已装入 ~/.bashrc'
} else {
    Write-Host '[5/6] 未检测到 Git Bash，跳过（不影响右键菜单和 pwsh）'
}

# 6. settings.json 的 statusLine
$settingsFile = Join-Path $claudeDir 'settings.json'
if (Test-Path -LiteralPath $settingsFile) {
    $json = Get-Content -LiteralPath $settingsFile -Raw | ConvertFrom-Json
    if (-not $json.PSObject.Properties['statusLine']) {
        $statusCmd = 'pwsh -NoProfile -NoLogo -File {0}' -f ((Join-Path $claudeDir 'cc-statusline.ps1') -replace '\\', '/')
        if (Get-Command pwsh -ErrorAction SilentlyContinue) {
            $json | Add-Member -NotePropertyName statusLine -NotePropertyValue ([ordered]@{ type = 'command'; command = $statusCmd })
            $json | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $settingsFile -Encoding UTF8
            Write-Host '[6/6] settings.json 已加 statusLine'
        } else {
            Write-Host '[6/6] 未找到 pwsh，跳过 statusLine（装好 PowerShell 7 后重跑本脚本）'
        }
    } else {
        Write-Host '[6/6] settings.json 已有 statusLine，跳过'
    }
} else {
    Write-Host '[6/6] 未找到 ~/.claude/settings.json，跳过 statusLine'
}

# ============ 摘要 ============
Write-Host ''
Write-Host '安装完成。后续步骤：' -ForegroundColor Green
Write-Host '  1. 运行 ccm 打开供应商管理器，新增/编辑配置（或从旧机器拷贝 providers/*.json 过来）'
Write-Host '  2. 新开终端即可用 cc / cc glm 等；资源管理器右键 "Claude Code（选模型）"'
if (Test-Path (Join-Path $env:USERPROFILE '.cc-switch')) {
    Write-Host '  3. 注意：检测到 cc-switch——它会整份重写 settings.json，请把 statusLine 段加进 cc-switch 的 "Claude 通用配置"，否则切换供应商后状态栏会消失' -ForegroundColor Yellow
}
