# dsh-cbx-orch 端到端冒烟（PowerShell / Windows 版）。
#
# 与 smoke/e2e.sh 等价的核心验证，面向 Windows 原生 PowerShell（无 bash/git-bash）：
#   profile 创建 → dsh 启动 → 静态面 → 鉴权流 → SSE → mock 任务生命周期
#   （create→run→test→done + hang 取消树级终止）→ 清理。
#
# 用法：powershell -ExecutionPolicy Bypass -File smoke/e2e.ps1
# 环境变量：CBX_SMOKE_PORT（默认 3180）、CBX_SMOKE_SKIP_JOB=1（跳过任务生命周期）。
# 与 e2e.sh 的差异：不验证三插件合体（dsh-ralph-loop/dsh-state-graph 为可选兄弟仓库）。
#
# mock 执行器：注入 CBX_CODEBUDDY 指向 smoke/mock-executor/codebuddy.mjs（node 执行，
# 跨平台），无真实编码 CLI 也能跑通全生命周期。
$ErrorActionPreference = "Stop"
$Pass = 0; $Fail = 0

function Check([string]$name, [scriptblock]$cond) {
  try {
    $ok = & $cond
    if ($ok) { Write-Host "PASS  $name"; $script:Pass++ }
    else { Write-Host "FAIL  $name"; $script:Fail++ }
  } catch {
    Write-Host "FAIL  $name ($($_.Exception.Message))"; $script:Fail++
  }
}

$PluginDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$SmokeWs = Join-Path $PluginDir ".smoke-ws"
$Port = if ($env:CBX_SMOKE_PORT) { [int]$env:CBX_SMOKE_PORT } else { 3180 }
$Base = "http://127.0.0.1:$Port"
$ProfileDir = Join-Path $env:DSH_HOME "profiles\cbx"
$Log = Join-Path $SmokeWs "dsh-smoke.log"
$SseOut = Join-Path $SmokeWs "sse-out.txt"
$CookieFile = Join-Path $SmokeWs "cookies.txt"

# --- 清理：停止 dsh 进程（按端口）---
function Stop-DshOnPort([int]$port) {
  $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conn) {
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-CbxGet([string]$url, $session = $null) {
  $params = @{ Uri = $url; UseBasicParsing = $true; TimeoutSec = 5 }
  if ($session) { $params.WebSession = $session }
  (Invoke-WebRequest @params).Content
}

function Invoke-CbxStatus([string]$jobId, $session = $null) {
  $json = Invoke-CbxGet "$Base/cbx/api/jobs/$jobId" $session
  ($json | ConvertFrom-Json).status
}

# git 辅助：git 的 stderr 警告（如 LF/CRLF）在 $ErrorActionPreference=Stop 下会抛
# NativeCommandError 中断脚本。统一用 -ErrorAction SilentlyContinue + 忽略退出码。
function Invoke-Git([string[]]$argsList, [string]$cwd) {
  $oldEA = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  try {
    & git -C $cwd @argsList 2>&1 | Out-Null
  } finally {
    $ErrorActionPreference = $oldEA
  }
}

try {
  # === 0. 前置：build 产物存在 ===
  if (-not (Test-Path (Join-Path $PluginDir "lib\index.js"))) {
    Write-Host "      插件未构建，build"
    Push-Location $PluginDir
    try { npm run build | Out-Null } finally { Pop-Location }
  }
  Check "插件构建产物存在" { Test-Path (Join-Path $PluginDir "lib\index.js") }

  # === 1. profile 创建（不存在则自动创建）===
  if (-not (Test-Path (Join-Path $ProfileDir "package.json"))) {
    New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
    $pkg = @{
      name = "dsh-profile-cbx"; private = $true
      dependencies = @{ "dsh-cbx-orch" = "file:$PluginDir" }
      dsh = @{ profile = @{ bundles = @("@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-cbx-orch") } }
    } | ConvertTo-Json -Depth 5
    # 无 BOM UTF-8：Windows PowerShell 5.1 的 Set-Content -Encoding UTF8 会写 BOM，
    # dsh 的 JSON.parse 会因 BOM 报 "Unexpected token ''"（manifest 读取失败）。
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText((Join-Path $ProfileDir "package.json"), $pkg, $utf8NoBom)
    # cordis.patch.yml：允许冒烟工作区（同样无 BOM）
    $wsYaml = $SmokeWs.Replace("\", "\\")
    $patch = @"
- id: cbx-orch-web
  config:
    web:
      workspaces:
        - '$wsYaml'
"@
    [System.IO.File]::WriteAllText((Join-Path $ProfileDir "cordis.patch.yml"), $patch, $utf8NoBom)
    Write-Host "      已创建 profile $ProfileDir"
  }
  Push-Location $ProfileDir
  try { npm install --no-audit --no-fund 2>&1 | Out-Null } finally { Pop-Location }
  Check "profile 依赖就绪" { Test-Path (Join-Path $ProfileDir "node_modules\dsh-cbx-orch") }

  # 冒烟工作区：干净 git 仓库
  New-Item -ItemType Directory -Force -Path $SmokeWs | Out-Null
  Push-Location $SmokeWs
  try {
    if (-not (Test-Path (Join-Path $SmokeWs ".git"))) {
      Invoke-Git @("init", "-q") $SmokeWs
      Invoke-Git @("config", "user.email", "smoke@t") $SmokeWs
      Invoke-Git @("config", "user.name", "smoke") $SmokeWs
      Set-Content -Path (Join-Path $SmokeWs "README.md") -Value "hello`n" -Encoding UTF8
    }
    Set-Content -Path (Join-Path $SmokeWs ".gitignore") -Value "dsh-smoke.log`n.cbx/`n" -Encoding UTF8
    Invoke-Git @("add", "-A") $SmokeWs
    Invoke-Git @("commit", "-qm", "smoke init") $SmokeWs
  } finally { Pop-Location }
  $oldEA = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  $clean = ""
  try {
    $clean = (& git -C $SmokeWs status --porcelain --untracked-files=all -- . 2>&1 | Out-String).Trim()
  } finally {
    $ErrorActionPreference = $oldEA
  }
  Check "工作区是干净 git 仓库" { $clean -eq "" }

  # === 2. 启动 dsh（mock 执行器注入）===
  $env:CBX_CODEBUDDY = Join-Path $PluginDir "smoke\mock-executor\codebuddy.mjs"
  Stop-DshOnPort $Port
  # dsh 是 .ps1 脚本（Windows npm 全局安装）：经 powershell -File 启动。
  $dshCmd = (Get-Command dsh -ErrorAction SilentlyContinue).Source
  if (-not $dshCmd) { $dshCmd = "dsh.ps1" }
  $proc = Start-Process -FilePath "powershell" -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$dshCmd`"", "--profile", "cbx", "--port", "$Port" `
    -WorkingDirectory $SmokeWs -RedirectStandardOutput $Log -RedirectStandardError "$Log.err" -PassThru -WindowStyle Hidden
  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try { $r = Invoke-WebRequest "$Base/cbx/" -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { $ready = $true; break } } catch {}
  }
  Check "服务启动 /cbx/ 200" { $ready }

  # === 3. 静态面 ===
  $redirect = $false
  try { $r = Invoke-WebRequest "$Base/cbx" -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 5 -ErrorAction SilentlyContinue; if ($r.StatusCode -eq 301) { $redirect = $true } } catch { if ($_.Exception.Response.StatusCode -eq 301) { $redirect = $true } }
  Check "/cbx → 301 到 /cbx/" { $redirect }
  $csp = $false
  try { $r = Invoke-WebRequest "$Base/cbx/" -UseBasicParsing -TimeoutSec 5; $csp = [bool]($r.Headers["Content-Security-Policy"] -match "default-src") } catch {}
  Check "/cbx/ 带 CSP" { $csp }
  Check "style.css 200" { (Invoke-WebRequest "$Base/cbx/style.css" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 }
  Check "app.js 200" { (Invoke-WebRequest "$Base/cbx/app.js" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 }
  $healthz = $false
  try { $healthz = (Invoke-CbxGet "$Base/cbx/healthz") -match "queueDepth" } catch {}
  Check "healthz 只读指标" { $healthz }
  $unauth = $false
  try { $r = Invoke-WebRequest "$Base/cbx/api/jobs" -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue; if ($r.StatusCode -eq 401) { $unauth = $true } } catch { if ($_.Exception.Response.StatusCode -eq 401) { $unauth = $true } }
  Check "数据端点无 token 401" { $unauth }

  # === 4. 鉴权流 ===
  $tokenFile = Join-Path $SmokeWs ".cbx\web.token"
  $token = ""
  if (Test-Path $tokenFile) { $token = (Get-Content $tokenFile -Raw).Trim() }
  Check "web.token 已生成" { $token -ne "" }
  $badAuth = $false
  try { $r = Invoke-WebRequest "$Base/cbx/auth" -Method POST -ContentType "application/json" -Body '{"token":"wrong"}' -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue; if ($r.StatusCode -eq 401) { $badAuth = $true } } catch { if ($_.Exception.Response.StatusCode -eq 401) { $badAuth = $true } }
  Check "错误 token 401" { $badAuth }
  $goodAuth = $false
  try {
    $r = Invoke-WebRequest "$Base/cbx/auth" -Method POST -ContentType "application/json" -Body (@{ token = $token } | ConvertTo-Json) -UseBasicParsing -TimeoutSec 5 -SessionVariable cbxSession
    $goodAuth = $r.Content -match "ok"
    # PS 5.1 的 SessionVariable 自动管理 cookie，后续请求用 -WebSession $cbxSession 携带
    $script:cbxSession = $cbxSession
  } catch { Write-Host "      auth 调试: $($_.Exception.Message)" }
  Check "正确 token 换 cookie" { $goodAuth }
  Check "session 已建立" { $null -ne $script:cbxSession }
  $cookieOk = $false
  try {
    $r = Invoke-WebRequest "$Base/cbx/api/jobs" -UseBasicParsing -TimeoutSec 5 -WebSession $script:cbxSession -ErrorAction SilentlyContinue
    if ($r.StatusCode -eq 200) { $cookieOk = $true }
  } catch { if ($_.Exception.Response.StatusCode -eq 200) { $cookieOk = $true } }
  Check "cookie 访问数据端点 200" { $cookieOk }

  # === 5. SSE（短连接验证 connected 事件；用 Bearer header——URL query token 被拒）===
  $sseOk = $false
  try {
    $sse = Start-Job -ScriptBlock {
      param($u, $tkn)
      $r = Invoke-WebRequest $u -UseBasicParsing -TimeoutSec 6 -Headers @{ Authorization = "Bearer $tkn" }
      $r.Content
    } -ArgumentList "$Base/cbx/events", $token
    Start-Sleep -Seconds 3
    $content = Receive-Job $sse -Keep 2>$null
    Stop-Job $sse -ErrorAction SilentlyContinue; Remove-Job $sse -Force -ErrorAction SilentlyContinue
    $sseOk = ($content -join "") -match '"type":"connected"'
  } catch {}
  Check "SSE 收到 connected" { $sseOk }

  # === 6. mock 任务生命周期 ===
  if ($env:CBX_SMOKE_SKIP_JOB -eq "1") {
    Write-Host "SKIP  （CBX_SMOKE_SKIP_JOB=1：跳过任务生命周期）"
  } else {
    $wsEnc = [uri]::EscapeDataString($SmokeWs)
    $createBody = @{ task = "e2e smoke"; review = $false; isolated = $true; test_command = "echo smoke-done"; timeout_ms = 20000; max_retries = 0 } | ConvertTo-Json
    $jobId = ""
    try {
      $r = Invoke-WebRequest "$Base/cbx/api/jobs?workspace=$wsEnc" -Method POST -ContentType "application/json" -Body $createBody -UseBasicParsing -TimeoutSec 10 -WebSession $script:cbxSession
      $jobId = ($r.Content | ConvertFrom-Json).job_id
    } catch {}
    Check "任务创建返回 job_id" { $jobId -ne "" }
    $ran = $false
    for ($i = 0; $i -lt 8; $i++) {
      try { if ((Invoke-CbxStatus $jobId $script:cbxSession) -eq "running") { $ran = $true; break } } catch {}
      Start-Sleep -Seconds 1
    }
    Check "任务进入 running(调度器+worker 生效)" { $ran }
    # mock 顺利 → done（test 是 echo 恒成功）
    $done = $false
    for ($i = 0; $i -lt 15; $i++) {
      try {
        $st = Invoke-CbxStatus $jobId $script:cbxSession
        if ($st -eq "done") { $done = $true; break }
        if ($st -eq "failed") { break }
      } catch {}
      Start-Sleep -Seconds 1
    }
    Check "mock 任务终态 done(执行+测试+收口)" { $done }
    Check "result.json 已落盘" { Test-Path (Join-Path $SmokeWs ".cbx\jobs\$jobId\result.json") }
    Check "事件流已落盘" { Test-Path (Join-Path $SmokeWs ".cbx\jobs\$jobId\events.ndjson") }

    # hang 任务取消：树级终止 + pid 归属
    $hangBody = @{ task = "e2e smoke hang __mock_hang__"; review = $false; isolated = $true; test_command = "echo x"; timeout_ms = 20000; max_retries = 0 } | ConvertTo-Json
    $hangId = ""
    try {
      $r = Invoke-WebRequest "$Base/cbx/api/jobs?workspace=$wsEnc" -Method POST -ContentType "application/json" -Body $hangBody -UseBasicParsing -TimeoutSec 10 -WebSession $script:cbxSession
      $hangId = ($r.Content | ConvertFrom-Json).job_id
    } catch {}
    Check "hang 任务创建返回 job_id" { $hangId -ne "" }
    $hr = $false
    for ($i = 0; $i -lt 8; $i++) {
      try { if ((Invoke-CbxStatus $hangId $script:cbxSession) -eq "running") { $hr = $true; break } } catch {}
      Start-Sleep -Seconds 1
    }
    Check "hang 任务进入 running" { $hr }
    try { Invoke-WebRequest "$Base/cbx/api/jobs/$hangId/cancel" -Method POST -ContentType "application/json" -Body "{}" -UseBasicParsing -TimeoutSec 10 -WebSession $script:cbxSession | Out-Null } catch {}
    Start-Sleep -Seconds 4
    $hf = ""
    try { $hf = Invoke-CbxStatus $hangId $script:cbxSession } catch {}
    Check "取消 hang 任务终态 cancelled(树级终止生效)" { $hf -eq "cancelled" }
  }
} finally {
  # 清理：停 dsh 进程
  Stop-DshOnPort $Port
  Stop-DshOnPort ($Port + 1)
}

Write-Host ""
Write-Host "结果: $Pass 通过 / $Fail 失败"
if ($Fail -ne 0) {
  Write-Host "--- dsh 日志尾部 ---"
  if (Test-Path $Log) { Get-Content $Log -Tail 20 }
  if (Test-Path "$Log.err") { Get-Content "$Log.err" -Tail 20 }
  exit 1
}
Write-Host "E2E 全部通过"
