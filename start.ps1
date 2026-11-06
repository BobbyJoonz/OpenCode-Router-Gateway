# ==========================================================
#  OpenCode Router - Windows launcher (PowerShell 5.1+ / 7+)
#  Mirrors start.sh for Linux. Run:  powershell -ExecutionPolicy Bypass -File .\start.ps1
# ==========================================================
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectDir

$Port = if ($env:PORT) { $env:PORT } else { '3000' }
$XrayVer = 'v26.10.31'

Write-Host "=========================================================="
Write-Host "  Starting OpenCode Router (Windows)"
Write-Host "=========================================================="

# --- 1. Download Xray-core (xray.exe) if missing -------------------------
$XrayExe = Join-Path $ProjectDir 'bin\xray.exe'
if (-not (Test-Path $XrayExe)) {
    Write-Host "Downloading Xray-core..."
    New-Item -ItemType Directory -Force -Path (Join-Path $ProjectDir 'bin') | Out-Null
    $zip = Join-Path $env:TEMP "xray-win64-$([guid]::NewGuid().ToString('N')).zip"
    $raw = "https://github.com/XTLS/Xray-core/releases/download/$XrayVer/Xray-windows-64.zip"
    # GitHub is blocked in some regions; try direct, then public mirrors.
    $urls = @(
        $raw,
        "https://gh-proxy.com/$raw",
        "https://ghfast.top/$raw"
    )
    $ok = $false
    foreach ($u in $urls) {
        try {
            Invoke-WebRequest -Uri $u -OutFile $zip -TimeoutSec 180 -UseBasicParsing
            if ((Get-Item $zip).Length -gt 1000000) { $ok = $true; break }
        } catch {
            Write-Host "  mirror failed: $u"
        }
    }
    if ($ok) {
        Expand-Archive -Path $zip -DestinationPath (Join-Path $ProjectDir 'bin') -Force
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
        Write-Host "Xray-core ready: $XrayExe"
    } else {
        Write-Host "WARNING: could not download Xray-core. Place xray.exe in .\bin\ manually."
    }
}

# --- 2. Build frontend if dist/ is missing -------------------------------
if (-not (Test-Path (Join-Path $ProjectDir 'src\frontend\dist\index.html'))) {
    Write-Host "Compiling frontend..."
    Push-Location (Join-Path $ProjectDir 'src\frontend')
    try { npx vite build } finally { Pop-Location }
}

# --- 3. Start backend ----------------------------------------------------
Write-Host "Launching backend server on port $Port ..."
$env:PORT = $Port
$server = Start-Process -FilePath 'npx' -ArgumentList 'tsx', 'src/backend/server.ts' `
    -PassThru -NoNewWindow -WorkingDirectory $ProjectDir
# npx on Windows is npx.cmd; Start-Process handles it.

# --- 4. Wait for readiness ----------------------------------------------
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/status" -UseBasicParsing -TimeoutSec 3
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
}

if ($ready) {
    Write-Host ""
    Write-Host "=========================================================="
    Write-Host "  Application running at: http://localhost:$Port"
    Write-Host "=========================================================="
    Write-Host "Open the dashboard and click [ Find Working Connection ]"
    Write-Host "Press Ctrl+C to stop."
    Start-Process "http://localhost:$Port"
} else {
    Write-Host "WARNING: server did not become ready in time. Check the log above."
}

# --- 5. Keep the launcher alive -----------------------------------------
try { Wait-Process -Id $server.Id } catch { }
