<#
cc-setup.ps1 — Claude Code 多供应商启动器 一键安装（自包含，无外部依赖）

在新机器上执行（需已安装 Claude Code，建议装好 PowerShell 7 与 Windows Terminal）：
    pwsh -ExecutionPolicy Bypass -File cc-setup.ps1

会安装：
  1. ~/.claude/cc-launch.ps1            启动器（右键菜单用）
  2. ~/.claude/cc-statusline.ps1        状态栏脚本
  3. ~/.claude/providers/*.json         供应商配置模板（已存在的不覆盖）
  4. 资源管理器右键菜单 "Claude Code（选模型）"
  5. pwsh / Git Bash 的 ccp 命令（幂等，可重复执行）
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

# ---------- Win32 与主题（cc-switch 风格：浅色卡片 / 跟随系统深浅色） ----------

# DPI 感知（PerMonitorV2）：必须建窗口前声明，否则高分屏上整个窗口按位图拉伸发虚
try {
    Add-Type -Namespace CcUi -Name Native -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetProcessDpiAwarenessContext(int value);
[System.Runtime.InteropServices.DllImport("dwmapi.dll")]
public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, string lParam);
"@
    [void][CcUi.Native]::SetProcessDpiAwarenessContext(-4)
} catch {}

$light = $true
try {
    if ((Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -ErrorAction Stop).AppsUseLightTheme -eq 0) { $light = $false }
} catch {}
$theme = if ($light) {
    @{ bg = '#F3F4F6'; card = '#FFFFFF'; border = '#E3E5EA'; text = '#1F2328'; sub = '#71767F'
       inputBg = '#FFFFFF'; inputBorder = '#D9DDE3'; chipBg = '#ECEEF2'; chipHover = '#E0E3E9'
       accent = '#3B82F6'; accentHover = '#2F76E4'; onAccent = '#FFFFFF'
       orange = '#F97316'; orangeHover = '#EA580C'
       green = '#10B981'; red = '#EF4444'; redHover = '#DC2626' }
} else {
    @{ bg = '#1D1E22'; card = '#26282E'; border = '#3A3D45'; text = '#E6E8EC'; sub = '#9CA3AF'
       inputBg = '#17181C'; inputBorder = '#4A4E59'; chipBg = '#33353D'; chipHover = '#3E414A'
       accent = '#4C8DFF'; accentHover = '#6AA1FF'; onAccent = '#0B1220'
       orange = '#FB923C'; orangeHover = '#FDBA74'
       green = '#34D399'; red = '#F87171'; redHover = '#FCA5A5' }
}

function Get-Clr([string]$Hex) { [System.Drawing.ColorTranslator]::FromHtml($Hex) }
function Get-RoundPath([float]$X, [float]$Y, [float]$W, [float]$H, [int]$R) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = 2 * $R
    $p.AddArc($X, $Y, $d, $d, 180, 90)
    $p.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
    $p.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
    $p.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}
function Set-RoundRegion($Ctl, [int]$R) {
    $Ctl.Region = New-Object System.Drawing.Region (Get-RoundPath 0 0 $Ctl.Width $Ctl.Height $R)
}
function Enable-DarkTitleBar($Win) {
    if ($light) { return }
    $v = 1
    if ([CcUi.Native]::DwmSetWindowAttribute($Win.Handle, 20, [ref]$v, 4) -ne 0) {
        [void][CcUi.Native]::DwmSetWindowAttribute($Win.Handle, 19, [ref]$v, 4)
    }
}

$uiFont      = New-Object System.Drawing.Font('Segoe UI', 9.5)
$uiFontSub   = New-Object System.Drawing.Font('Segoe UI', 9)
$uiFontTitle = New-Object System.Drawing.Font('Segoe UI Semibold', 12)
$uiFontCard  = New-Object System.Drawing.Font('Segoe UI Semibold', 10.5)
$uiFontInput = New-Object System.Drawing.Font('Segoe UI', 10.5)

# 高分屏：手工窗体不会自动按 DPI 缩放，所有像素常量按 96dpi 基准书写、经 Px() 放大
# （字体用 Point 单位会自行跟随 DPI，不用缩）。不用 Control.Scale()：其与模态对话框
# 组合时会把窗口压回 96dpi 基准，行为不可控。
$script:uiScale = 1.0
try {
    $g0 = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
    $script:uiScale = [double]::Round($g0.DpiX / 96, 3)
    $g0.Dispose()
} catch {}
function Px([int]$V) { [int][Math]::Round($V * $script:uiScale) }

function New-FlatButton([string]$Text, [int]$W, [int]$H, [string]$Kind = 'ghost') {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $Text
    $b.Size = New-Object System.Drawing.Size((Px $W), (Px $H))
    $b.FlatStyle = 'Flat'
    $b.FlatAppearance.BorderSize = 0
    $b.Cursor = 'Hand'
    $b.TabStop = $false
    switch ($Kind) {
        'orange' {
            $b.BackColor = Get-Clr $theme.orange
            $b.ForeColor = [System.Drawing.Color]::White
            $b.FlatAppearance.MouseOverBackColor = Get-Clr $theme.orangeHover
        }
        'primary' {
            $b.BackColor = Get-Clr $theme.accent
            $b.ForeColor = Get-Clr $theme.onAccent
            $b.FlatAppearance.MouseOverBackColor = Get-Clr $theme.accentHover
        }
        'danger' {
            $b.BackColor = Get-Clr $theme.chipBg
            $b.ForeColor = Get-Clr $theme.sub
            $b.FlatAppearance.MouseOverBackColor = Get-Clr $theme.redHover
        }
        default {
            $b.BackColor = Get-Clr $theme.chipBg
            $b.ForeColor = Get-Clr $theme.text
            $b.FlatAppearance.MouseOverBackColor = Get-Clr $theme.chipHover
        }
    }
    # 圆角随控件尺寸重算（DPI 缩放后 Region 不会自己跟着变）
    $b.Add_Resize({ Set-RoundRegion $this 6 })
    Set-RoundRegion $b 6
    return $b
}

# 输入框：自绘圆角容器（白底 + 描边，聚焦变主题蓝），内嵌无边框 TextBox。
# TextBox 高度取 PreferredHeight（正好一行文字、descender 完整），在格子里垂直居中——
# Dock Fill 会让文字偏上且裁下伸字母（g/y/p）。容器只用于绝对布局，勿入 TableLayoutPanel。
function New-Input([int]$H = 44) {
    $boxHost = New-Object System.Windows.Forms.Panel
    $st = @{ focus = $false }
    $tb = New-Object System.Windows.Forms.TextBox
    $tb.BorderStyle = 'None'
    $tb.Font = $uiFontInput
    $tb.BackColor = Get-Clr $theme.inputBg
    $tb.ForeColor = Get-Clr $theme.text
    $boxHost.Controls.Add($tb)
    # 文字自适应行高、格子内垂直居中；容器尺寸由调用方 SetBounds 定，之后随 Resize 重排
    $layoutTb = {
        $tb.SetBounds((Px 12), [int](($boxHost.Height - $tb.PreferredHeight) / 2), [Math]::Max(10, $boxHost.Width - (Px 24)), $tb.PreferredHeight)
    }.GetNewClosure()
    $boxHost.Add_Resize({ & $layoutTb }.GetNewClosure())
    & $layoutTb
    $boxHost.Cursor = 'IBeam'
    # 点格子的任意位置都聚焦输入框——否则点边缘没反应，像不可编辑
    $boxHost.Add_MouseDown({ $tb.Focus() }.GetNewClosure())
    $boxHost.Add_Paint({
        param($s, $e)
        $e.Graphics.SmoothingMode = 'AntiAlias'
        $path = Get-RoundPath 0 0 ($s.Width - 1) ($s.Height - 1) 8
        $e.Graphics.FillPath((New-Object System.Drawing.SolidBrush (Get-Clr $theme.inputBg)), $path)
        $edge = if ($st.focus) { $theme.accent } else { $theme.inputBorder }
        $e.Graphics.DrawPath((New-Object System.Drawing.Pen (Get-Clr $edge)), $path)
        $path.Dispose()
    }.GetNewClosure())
    $tb.Add_Enter({ $st.focus = $true; $boxHost.Invalidate() }.GetNewClosure())
    $tb.Add_Leave({ $st.focus = $false; $boxHost.Invalidate() }.GetNewClosure())
    return @{ Host = $boxHost; Box = $tb }
}

# ---------- 编辑/新增对话框（绝对布局：不参与 TLP 自动布局协商，尺寸完全可控） ----------

function Show-EditDialog($existing) {
    $isNew = $null -eq $existing
    $dlg = New-Object System.Windows.Forms.Form
    $dlg.Text            = if ($isNew) { '新增供应商' } else { "编辑 — $($existing.Name)" }
    $dlg.FormBorderStyle = 'FixedDialog'
    $dlg.MaximizeBox     = $false
    $dlg.StartPosition   = 'CenterParent'
    $dlg.ClientSize      = New-Object System.Drawing.Size((Px 540), (Px 682))
    $dlg.TopMost         = $true   # 主窗口 TopMost，编辑框不置顶会被挡在主窗口后面
    # AutoScaleMode 必须显式 None：顶级 Form 默认按字体自动缩放，显示时会把窗口压回 96dpi 基准
    $dlg.AutoScaleMode   = [System.Windows.Forms.AutoScaleMode]::None
    $dlg.Font            = $uiFont
    $dlg.BackColor       = Get-Clr $theme.bg

    function Add-Label([string]$Text, [int]$X, [int]$Y, [bool]$Sub = $true) {
        $l = New-Object System.Windows.Forms.Label
        $l.Text = $Text
        $l.Location = New-Object System.Drawing.Point((Px $X), (Px $Y))
        $l.AutoSize = $true
        $l.BackColor = 'Transparent'
        if ($Sub) { $l.Font = $uiFontSub; $l.ForeColor = Get-Clr $theme.sub }
        [void]$dlg.Controls.Add($l)
        return $l
    }

    $script:cueList = @()   # (TextBox, 提示文字) 对，窗口 Shown 句柄就绪后再设占位符
    function Add-Input([int]$X, [int]$Y, [int]$W, [int]$H, [string]$Hint) {
        $inp = New-Input $H
        $inp.Host.SetBounds((Px $X), (Px $Y), (Px $W), (Px $H))
        [void]$dlg.Controls.Add($inp.Host)
        $script:cueList += , @($inp.Box, $Hint)
        return $inp.Box
    }

    # 标题 + 快速预设
    $lblTitle = Add-Label $(if ($isNew) { '新增供应商' } else { '编辑供应商' }) 24 18 $false
    $lblTitle.Font = $uiFontTitle
    $lblTitle.ForeColor = Get-Clr $theme.text
    [void](Add-Label '快速预设：' 24 62)
    $presetOfficial = New-FlatButton '官方' 68 32
    $presetOfficial.Location = New-Object System.Drawing.Point((Px 94), (Px 56))
    $presetGlm = New-FlatButton 'GLM' 74 32
    $presetGlm.Location = New-Object System.Drawing.Point((Px 168), (Px 56))
    $presetDs = New-FlatButton 'DeepSeek' 92 32
    $presetDs.Location = New-Object System.Drawing.Point((Px 248), (Px 56))
    $dlg.Controls.AddRange(@($presetOfficial, $presetGlm, $presetDs))

    # 主字段（标签上、输入框下；行距 78，输入框高 44 带内边距）
    $tbName = $null; $tbUrl = $null; $tbToken = $null; $tbModel = $null
    foreach ($f in @(
        , @('名称',    '英文/数字/-/_，如 glm',       104, [ref]$tbName)
        , @('接口地址', 'https://…（官方留空）',        182, [ref]$tbUrl)
        , @('Token',   'ANTHROPIC_AUTH_TOKEN（sk-…）', 260, [ref]$tbToken)
        , @('主模型',  '如 glm-5.3[1M]',               338, [ref]$tbModel)
    )) {
        [void](Add-Label $f[0] 24 ($f[2] - 22))
        $f[3].Value = Add-Input 24 $f[2] 492 44 $f[1]
    }

    # 高级：浅灰圆角卡片内 2×2
    $adv = New-Object System.Windows.Forms.Panel
    $adv.SetBounds((Px 24), (Px 432), (Px 492), (Px 176))
    $adv.BackColor = 'Transparent'
    $adv.Add_Paint({
        param($s, $e)
        $e.Graphics.SmoothingMode = 'AntiAlias'
        $path = Get-RoundPath 0 0 ($s.Width - 1) ($s.Height - 1) 10
        $e.Graphics.FillPath((New-Object System.Drawing.SolidBrush (Get-Clr $theme.chipBg)), $path)
        $path.Dispose()
    })
    [void]$dlg.Controls.Add($adv)
    $lblAdv = New-Object System.Windows.Forms.Label
    $lblAdv.Text = '高级 — 档位映射与超时（可留空）'
    $lblAdv.Font = $uiFontSub
    $lblAdv.ForeColor = Get-Clr $theme.sub
    $lblAdv.BackColor = 'Transparent'
    $lblAdv.Location = New-Object System.Drawing.Point((Px 14), (Px 12))
    $lblAdv.AutoSize = $true
    [void]$adv.Controls.Add($lblAdv)

    $tbHaiku = $null; $tbOpus = $null; $tbSonnet = $null; $tbTimeout = $null
    foreach ($f in @(
        , @('HAIKU 映射',     14,  40, [ref]$tbHaiku)
        , @('OPUS 映射',      258, 40, [ref]$tbOpus)
        , @('SONNET 映射',    14,  116, [ref]$tbSonnet)
        , @('API_TIMEOUT_MS', 258, 116, [ref]$tbTimeout)
    )) {
        $lb = New-Object System.Windows.Forms.Label
        $lb.Text = $f[0]
        $lb.Font = $uiFontSub
        $lb.ForeColor = Get-Clr $theme.sub
        $lb.BackColor = 'Transparent'
        $lb.Location = New-Object System.Drawing.Point((Px $f[1]), (Px $f[2]))
        $lb.AutoSize = $true
        [void]$adv.Controls.Add($lb)
        $inp = New-Input 38
        $inp.Host.SetBounds((Px $f[1]), (Px ($f[2] + 20)), (Px 220), (Px 38))
        [void]$adv.Controls.Add($inp.Host)
        $f[3].Value = $inp.Box
    }

    # 底部按钮（右对齐：取消次级、保存主色）
    $btnCancel = New-FlatButton '取消' 96 34
    $btnCancel.Location = New-Object System.Drawing.Point((Px 316), (Px 632))
    $btnCancel.DialogResult = 'Cancel'
    $btnOk = New-FlatButton '保存' 96 34 'primary'
    $btnOk.Location = New-Object System.Drawing.Point((Px 420), (Px 632))
    $btnOk.DialogResult = 'OK'
    $dlg.Controls.AddRange(@($btnCancel, $btnOk))
    $dlg.AcceptButton = $btnOk
    $dlg.CancelButton = $btnCancel

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
        $tbName.Text    = $existing.Name
        $tbUrl.Text     = [string]$existing.Env.ANTHROPIC_BASE_URL
        $tbToken.Text   = [string]$existing.Env.ANTHROPIC_AUTH_TOKEN
        $tbModel.Text   = [string]$existing.Env.ANTHROPIC_MODEL
        $tbHaiku.Text   = [string]$existing.Env.ANTHROPIC_DEFAULT_HAIKU_MODEL
        $tbOpus.Text    = [string]$existing.Env.ANTHROPIC_DEFAULT_OPUS_MODEL
        $tbSonnet.Text  = [string]$existing.Env.ANTHROPIC_DEFAULT_SONNET_MODEL
        $tbTimeout.Text = [string]$existing.Env.API_TIMEOUT_MS
    }

    $dlg.Add_Shown({
        Enable-DarkTitleBar $dlg
        # EM_SETCUEBANNER：wParam=1 聚焦时也显示占位提示（注意 [IntPtr]1 不能写成 [IntPtr]::1）
        foreach ($pair in $script:cueList) {
            if ($pair[1]) { [void][CcUi.Native]::SendMessage($pair[0].Handle, 0x1501, [IntPtr]1, $pair[1]) }
        }
    })

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

function New-ProviderCard($p) {
    $card = New-Object System.Windows.Forms.Panel
    $card.Width = Px 640   # 基准宽度：右缘锚定的按钮/徽标按它定位，入列后再拉伸到列表宽
    $card.Height = Px 88
    $card.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, (Px 16))
    $card.Cursor = 'Hand'
    $card.BackColor = Get-Clr $theme.bg

    # 厂商主色：与 wt tab / 状态栏配色一致（glm 系=青，deepseek 系=蓝，官方=绿，其余=黄）
    $brand = if (-not $p.Url) { '#2ECC71' }
             elseif ($p.Name -like 'glm*') { '#00B8A9' }
             elseif ($p.Name -like 'deepseek*') { '#4D6FFF' }
             else { '#F1C40F' }
    $initial = $p.Name.Substring(0, 1).ToUpper()

    $st = @{ hover = $false }
    $card.Add_Paint({
        param($s, $e)
        $e.Graphics.SmoothingMode = 'AntiAlias'
        $path = Get-RoundPath 0 0 ($s.Width - 1) ($s.Height - 1) 10
        $e.Graphics.FillPath((New-Object System.Drawing.SolidBrush (Get-Clr $theme.card)), $path)
        $edge = if ($st.hover) { $theme.accent } else { $theme.border }
        $e.Graphics.DrawPath((New-Object System.Drawing.Pen (Get-Clr $edge)), $path)
        $path.Dispose()
    }.GetNewClosure())
    # 鼠标移到子控件上会误触发 MouseLeave，按坐标判断是否真的离开卡片
    $card.Add_MouseEnter({ $st.hover = $true; $card.Invalidate() }.GetNewClosure())
    $card.Add_MouseLeave({
        if (-not $card.ClientRectangle.Contains($card.PointToClient([System.Windows.Forms.Cursor]::Position))) {
            $st.hover = $false; $card.Invalidate()
        }
    }.GetNewClosure())

    $editClick = { Invoke-EditProvider $p.Name }.GetNewClosure()

    # 图标方块（厂商色 + 名称首字母）
    $icon = New-Object System.Windows.Forms.Panel
    $icon.SetBounds((Px 20), (Px 22), (Px 44), (Px 44))
    $icon.Cursor = 'Hand'
    $icon.Add_Paint({
        param($s, $e)
        $e.Graphics.SmoothingMode = 'AntiAlias'
        $path = Get-RoundPath 0 0 ($s.Width - 1) ($s.Height - 1) 10
        $e.Graphics.FillPath((New-Object System.Drawing.SolidBrush (Get-Clr $brand)), $path)
        $path.Dispose()
        $fmt = New-Object System.Drawing.StringFormat
        $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
        $e.Graphics.DrawString($initial, (New-Object System.Drawing.Font('Segoe UI Semibold', 15)), [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF(0, 0, $s.Width, $s.Height)), $fmt)
    }.GetNewClosure())
    $icon.Add_Click($editClick)
    [void]$card.Controls.Add($icon)

    $lblName = New-Object System.Windows.Forms.Label
    $lblName.Text = $p.Name
    $lblName.Font = $uiFontCard
    $lblName.ForeColor = Get-Clr $theme.text
    $lblName.BackColor = 'Transparent'
    $lblName.Location = New-Object System.Drawing.Point((Px 80), (Px 13))
    $lblName.AutoSize = $true
    $lblName.Cursor = 'Hand'
    $lblName.Add_Click($editClick)
    [void]$card.Controls.Add($lblName)

    $lblMeta = New-Object System.Windows.Forms.Label
    $lblMeta.Text = if ($p.Url) { "$($p.Url)  ·  $($p.Model)" } else { "官方 API  ·  $($p.Model)" }
    $lblMeta.Font = $uiFontSub
    $lblMeta.ForeColor = Get-Clr $theme.sub
    $lblMeta.BackColor = 'Transparent'
    $lblMeta.Location = New-Object System.Drawing.Point((Px 80), (Px 39))
    $lblMeta.AutoSize = $true
    $lblMeta.Cursor = 'Hand'
    $lblMeta.Add_Click($editClick)
    [void]$card.Controls.Add($lblMeta)

    $lblTok = New-Object System.Windows.Forms.Label
    $lblTok.Text = "Token: $($p.Masked)"
    $lblTok.Font = $uiFontSub
    $lblTok.ForeColor = Get-Clr $theme.sub
    $lblTok.BackColor = 'Transparent'
    $lblTok.Location = New-Object System.Drawing.Point((Px 80), (Px 59))
    $lblTok.AutoSize = $true
    $lblTok.Cursor = 'Hand'
    $lblTok.Add_Click($editClick)
    [void]$card.Controls.Add($lblTok)

    # 右下操作
    $btnEdit = New-FlatButton '编辑' 56 28
    $btnEdit.Location = New-Object System.Drawing.Point((Px 450), (Px 48))
    $btnEdit.Anchor = 'Right,Bottom'
    $btnTest = New-FlatButton '测试' 56 28
    $btnTest.Location = New-Object System.Drawing.Point((Px 510), (Px 48))
    $btnTest.Anchor = 'Right,Bottom'
    $btnDel = New-FlatButton '删除' 56 28 'danger'
    $btnDel.Location = New-Object System.Drawing.Point((Px 570), (Px 48))
    $btnDel.Anchor = 'Right,Bottom'
    $card.Controls.AddRange(@($btnEdit, $btnTest, $btnDel))
    $btnEdit.Add_Click($editClick)
    $btnTest.Add_Click({ Invoke-TestProvider $p.Name }.GetNewClosure())
    $btnDel.Add_Click({ Invoke-DelProvider $p.Name }.GetNewClosure())

    return $card
}

function Invoke-AddProvider {
    $r = Show-EditDialog $null
    if ($r) { Save-Provider $r.Name $r.Env | Out-Null; Refresh-List }
}
function Invoke-EditProvider([string]$Name) {
    $sel = (Get-Providers) | Where-Object { $_.Name -eq $Name }
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
}
function Invoke-DelProvider([string]$Name) {
    $ans = [System.Windows.Forms.MessageBox]::Show($form, "确定删除 $Name ？", '确认', 'YesNo', 'Warning')
    if ($ans -eq 'Yes') { Remove-Item -LiteralPath (Join-Path $providersDir ($Name + '.json')) -Force; Refresh-List }
}
function Invoke-TestProvider([string]$Name) {
    $sel = (Get-Providers) | Where-Object { $_.Name -eq $Name }
    if (-not $sel) { return }
    $statusLabel.Text = "正在测试 $Name …"
    $statusLabel.ForeColor = Get-Clr $theme.sub
    $form.Refresh()
    $msg = "$($sel.Name): $(Test-Provider $sel)"
    $statusLabel.Text = $msg
    if ($msg -match '不可达') { $statusLabel.ForeColor = Get-Clr $theme.red }
    elseif ($msg -match 'HTTP') { $statusLabel.ForeColor = Get-Clr $theme.green }
}

$form = New-Object System.Windows.Forms.Form
$form.Text          = 'Claude Code 供应商管理'
$form.StartPosition = 'CenterScreen'
$form.ClientSize    = New-Object System.Drawing.Size((Px 740), (Px 540))
$form.MinimumSize   = New-Object System.Drawing.Size((Px 580), (Px 420))
$form.TopMost       = $true
# AutoScaleMode 必须显式 None：顶级 Form 默认按字体自动缩放，显示时会把窗口压回 96dpi 基准
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$form.Font          = $uiFont
$form.BackColor     = Get-Clr $theme.bg

# 卡片列表（Dock 顺序：flow 先加才不会被顶栏/状态栏盖住）
$flow = New-Object System.Windows.Forms.FlowLayoutPanel
$flow.Dock = 'Fill'
$flow.FlowDirection = 'TopDown'
$flow.WrapContents = $false
$flow.AutoScroll = $true
$flow.BackColor = Get-Clr $theme.bg
$flow.Padding = New-Object System.Windows.Forms.Padding((Px 18), (Px 8), (Px 18), (Px 8))

# 顶栏：标题 + 副标题 + 右侧按钮
$top = New-Object System.Windows.Forms.Panel
$top.Dock = 'Top'
$top.Height = Px 64
$top.BackColor = Get-Clr $theme.bg
$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Text = 'Claude Code 供应商'
$lblTitle.Font = $uiFontTitle
$lblTitle.ForeColor = Get-Clr $theme.text
$lblTitle.Location = New-Object System.Drawing.Point((Px 20), (Px 12))
$lblTitle.AutoSize = $true
[void]$top.Controls.Add($lblTitle)
$lblSubTitle = New-Object System.Windows.Forms.Label
$lblSubTitle.Text = 'providers 配置管理 · 点击卡片编辑 · 启动用 ccp / 右键菜单'
$lblSubTitle.Font = $uiFontSub
$lblSubTitle.ForeColor = Get-Clr $theme.sub
$lblSubTitle.Location = New-Object System.Drawing.Point((Px 21), (Px 39))
$lblSubTitle.AutoSize = $true
[void]$top.Controls.Add($lblSubTitle)
$top.Add_Paint({
    param($s, $e)
    $e.Graphics.DrawLine((New-Object System.Drawing.Pen (Get-Clr $theme.border)), 0, $s.Height - 1, $s.Width, $s.Height - 1)
})
$topBtns = New-Object System.Windows.Forms.Panel
$topBtns.Dock = 'Right'
$topBtns.Width = Px 252
$topBtns.BackColor = Get-Clr $theme.bg
$btnFolder = New-FlatButton '打开目录' 92 32
$btnFolder.Location = New-Object System.Drawing.Point((Px 14), (Px 16))
$btnAdd = New-FlatButton '＋ 新增供应商' 130 32 'orange'
$btnAdd.Location = New-Object System.Drawing.Point((Px 112), (Px 16))
$topBtns.Controls.AddRange(@($btnFolder, $btnAdd))
[void]$top.Controls.Add($topBtns)

# 底部状态条（顶部分隔线 + 目录/测试结果）
$bottom = New-Object System.Windows.Forms.Panel
$bottom.Dock = 'Bottom'
$bottom.Height = Px 34
$bottom.BackColor = Get-Clr $theme.bg
$bottom.Add_Paint({
    param($s, $e)
    $e.Graphics.DrawLine((New-Object System.Drawing.Pen (Get-Clr $theme.border)), 0, 0, $s.Width, 0)
})
$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Dock = 'Fill'
$statusLabel.TextAlign = 'MiddleLeft'
$statusLabel.Font = $uiFontSub
$statusLabel.ForeColor = Get-Clr $theme.sub
$statusLabel.Padding = New-Object System.Windows.Forms.Padding((Px 20), 0, (Px 20), 0)
$statusLabel.Text = "目录: $providersDir"
$bottom.Controls.Add($statusLabel)

$form.Controls.Add($flow)
$form.Controls.Add($top)
$form.Controls.Add($bottom)

function Refresh-List {
    $flow.SuspendLayout()
    $flow.Controls.Clear()
    $any = $false
    foreach ($p in (Get-Providers)) {
        $any = $true
        $flow.Controls.Add((New-ProviderCard $p))
    }
    if (-not $any) {
        $empty = New-Object System.Windows.Forms.Label
        $empty.Text = '暂无配置 — 点右上「＋ 新增供应商」创建'
        $empty.Font = $uiFontSub
        $empty.ForeColor = Get-Clr $theme.sub
        $empty.AutoSize = $true
        $empty.Margin = New-Object System.Windows.Forms.Padding((Px 18), (Px 26), (Px 18), 0)
        $flow.Controls.Add($empty)
    }
    $flow.ResumeLayout($true)
    # 卡宽铺满列表区（滚动条余量 36）
    foreach ($c in $flow.Controls) {
        if ($c -is [System.Windows.Forms.Panel]) { $c.Width = [Math]::Max((Px 320), $flow.ClientSize.Width - (Px 36)) }
    }
}

$btnAdd.Add_Click({ Invoke-AddProvider })
$btnFolder.Add_Click({ Start-Process explorer.exe "/select,`"$providersDir`"" })
$form.Add_Shown({ Enable-DarkTitleBar $form })
$form.Add_Resize({ foreach ($c in $flow.Controls) { if ($c -is [System.Windows.Forms.Panel]) { $c.Width = [Math]::Max((Px 320), $flow.ClientSize.Width - (Px 36)) } } })

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
# 标题只在启动瞬间生效：claude 启动后会接管标题（显示会话/任务状态），不去覆盖它
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
            # nextResetTime：毫秒时间戳（周期耗尽态可能缺失），保存供状态栏算重置倒计时
            $resetMs = 0
            try { if ($lim.nextResetTime) { $resetMs = [long][double]$lim.nextResetTime } } catch {}
            $items += [pscustomobject]@{ kind = $kind; pct = [int][double]$lim.percentage; resetMs = $resetMs }
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
# 重置倒计时：>48h 显示 "6d18h"，>1h 显示 "2h31m"，<1h 显示 "37m"；已过期/无效返回空
function Format-Countdown([double]$RemainMs) {
    if ($RemainMs -le 60000) { return '' }
    $mins = [int][Math]::Floor($RemainMs / 60000)
    $h = [Math]::Floor($mins / 60)
    if ($h -ge 48) { $d = [Math]::Floor($h / 24); return "${d}d$($h % 24)h" }
    if ($h -gt 0) { return "${h}h$($mins % 60)m" } else { return "$($mins)m" }
}
$nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

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
    # resets_at：重置时间（ISO 字符串），存在时附倒计时
    function Get-ResetCd($Rl) {
        if (-not $Rl.resets_at) { return '' }
        try {
            $cd = Format-Countdown ([DateTimeOffset]::Parse([string]$Rl.resets_at).ToUnixTimeMilliseconds() - $nowMs)
            if ($cd) { return " $cd" }
        } catch {}
        return ''
    }
    if ($null -ne $rl.five_hour.used_percentage)  { $p = [int]$rl.five_hour.used_percentage;  $usageSeg += " · 5h $(PctColor $p)$p%$cEnd$(Get-ResetCd $rl.five_hour)" }
    if ($null -ne $rl.seven_day.used_percentage) { $p = [int]$rl.seven_day.used_percentage; $usageSeg += " · 周 $(PctColor $p)$p%$cEnd$(Get-ResetCd $rl.seven_day)" }
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
            $cd = ''
            # 旧缓存无 resetMs 字段时不显示，下一轮缓存刷新（≤10 分钟）自然带上
            if ($t.resetMs) { $cd = Format-Countdown ([double]$t.resetMs - $nowMs) }
            if ($t.kind -eq 'h5')   { $usageSeg += " · 5h $(PctColor $p)$p%$cEnd" + $(if ($cd) { " $cd" }) }
            if ($t.kind -eq 'week') { $usageSeg += " · 周 $(PctColor $p)$p%$cEnd" + $(if ($cd) { " $cd" }) }
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
# ccp           交互菜单选择 provider 后在当前终端启动 claude
# ccp <名称>    直接用 ~/.claude/providers/<名称>.json 启动（如 ccp glm）
# ccp default   不带 --settings，走当前全局默认配置
ccp() {
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
      echo "ccp: 配置不存在: $f" >&2
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
    echo "ccp: 未找到 $pdir/*.json" >&2
    return 1
  fi

  echo "选择要使用的模型配置:"
  echo "  0) default（当前全局默认配置）"
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
    echo "ccp: 无效选择: $n" >&2
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
# ccp           交互菜单选择 provider 后在当前终端启动 claude
# ccp <名称>    直接用 ~/.claude/providers/<名称>.json 启动（如 ccp glm）
# ccp default   不带 --settings，走当前全局默认配置
function ccp {
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
    Write-Host '  0) default（当前全局默认配置）'
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
Write-Host "[4/6] pwsh ccp 命令已装入 $PROFILE"

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
    Write-Host '[5/6] Git Bash ccp 命令已装入 ~/.bashrc'
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
Write-Host '  2. 新开终端即可用 ccp / ccp glm 等；资源管理器右键 "Claude Code（选模型）"'
if (Test-Path (Join-Path $env:USERPROFILE '.cc-switch')) {
    Write-Host '  3. 注意：检测到 cc-switch——它会整份重写 settings.json，请把 statusLine 段加进 cc-switch 的 "Claude 通用配置"，否则切换供应商后状态栏会消失' -ForegroundColor Yellow
}