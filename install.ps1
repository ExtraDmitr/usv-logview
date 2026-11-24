# usv-logview quick install for Windows: prepares this laptop to run the viewer, everything Python-side inside .\.venv (nothing installed
# globally except, if missing and you agree, Python 3.10+ and ffmpeg via winget).
#
#   install.bat                         (double-click) = the full install
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Minimal] [-Yes] [-Fresh] [-Check]
#     -Minimal  without the YOLO / CV_NEW detection engines (ultralytics + torch, ~1-2 GB)
#     -Yes      do not ask (install missing Python / ffmpeg with winget)
#     -Fresh    delete and rebuild .venv
#     -Check    only report what is there / missing
param([switch]$Minimal, [switch]$Yes, [switch]$Fresh, [switch]$Check)
$ErrorActionPreference = "Continue"     # native tools (pip, ffmpeg) write warnings to stderr; exit codes are checked instead
Set-Location -Path $PSScriptRoot
$env:PYTHONUTF8 = "1"

function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  [x]  $m" -ForegroundColor Red; exit 1 }
function Ask($q)  { if ($Yes) { return $true }; $r = Read-Host "  $q [Y/n]"; return ($r -eq "" -or $r -match "^[Yy]") }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") }
$haveWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)

Write-Host "usv-logview install (Windows$(if ($haveWinget) { ', winget' }))" -ForegroundColor White

# ---- 1. Python 3.10+
function Find-Python {
    $cands = @()
    if (Get-Command py -ErrorAction SilentlyContinue) { foreach ($v in "3.13", "3.12", "3.11", "3.10") { $cands += ,@("py", "-$v") } }
    foreach ($c in "python", "python3") { if (Get-Command $c -ErrorAction SilentlyContinue) { $cands += ,@($c) } }
    foreach ($c in $cands) {
        $exe = $c[0]; $args_ = @($c | Select-Object -Skip 1)
        try {
            & $exe @args_ -c "import sys, venv, ensurepip; sys.exit(0 if sys.version_info >= (3, 10) else 1)" 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { return ,$c }
        } catch { }
    }
    return $null
}
$py = Find-Python
if (-not $py) {
    Warn "no Python 3.10+ found (the Microsoft Store 'python' stub does not count)"
    if ($Check) { exit 1 }
    if ($haveWinget -and (Ask "install Python 3.12 with winget?")) {
        winget install -e --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
        Refresh-Path; $py = Find-Python
        if (-not $py) { Fail "Python installed but not found yet - open a new terminal and run install.bat again" }
    } else { Fail "install Python 3.10+ from https://www.python.org/downloads/ (tick 'Add python.exe to PATH') and run again" }
}
$pyExe = $py[0]; $pyArgs = @($py | Select-Object -Skip 1)
Ok ("Python " + (& $pyExe @pyArgs -c "import platform; print(platform.python_version())"))

# ---- 2. ffmpeg (the video cache)
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Warn "ffmpeg not found (needed to show the camera)"
    if (-not $Check -and $haveWinget -and (Ask "install ffmpeg with winget?")) {
        winget install -e --id Gyan.FFmpeg --accept-package-agreements --accept-source-agreements
        Refresh-Path
    }
}
if (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
    $enc = ""; try { $enc = (& ffmpeg -hide_banner -encoders 2>$null) -join "`n" } catch { }
    if ($enc -match "libx264") { Ok "ffmpeg (libx264)" } else { Warn "ffmpeg has no libx264 encoder: install a full build (winget install Gyan.FFmpeg)" }
} else { Warn "continuing without ffmpeg - the viewer runs, the camera tile will not (winget install Gyan.FFmpeg, then reopen the terminal)" }
if ($Check) { if (Test-Path .venv\Scripts\python.exe) { Ok ".venv present" } else { Warn ".venv missing (run install.bat)" }; exit 0 }

# ---- 3. the virtual environment
if ($Fresh -and (Test-Path .venv)) { Remove-Item -Recurse -Force .venv; Ok "removed the old .venv" }
if (-not (Test-Path .venv\Scripts\python.exe)) {
    & $pyExe @pyArgs -m venv .venv
    if ($LASTEXITCODE -ne 0) { Fail "could not create .venv" }
    Ok "created .venv"
} else { Ok "using the existing .venv" }
$vpy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
& $vpy -m pip install -q --upgrade pip
Write-Host "installing the Python packages into .venv ..." -ForegroundColor White
& $vpy -m pip install -q -r requirements.txt
if ($LASTEXITCODE -ne 0) { Fail "pip install -r requirements.txt failed" }
Ok "core packages (mcap, numpy, opencv, pillow, pyyaml, paho-mqtt)"
if (-not $Minimal) {
    Write-Host "  the detection engines (ultralytics + torch, a few minutes the first time) ..."
    & $vpy -m pip install -q -r requirements-ml.txt
    if ($LASTEXITCODE -eq 0) { Ok "detection engines (ultralytics, torch)" }
    else { Warn "ultralytics / torch failed - the viewer works, the YOLO / CV_NEW engines will show as not available" }
} else { Warn "-Minimal: detection engines skipped (install.bat later adds them)" }
"$(if ($Minimal) { 'minimal' } else { 'full' }) $(Get-Date -Format 'yyyy-MM-dd HH:mm')" | Set-Content .venv\.logview_installed

# ---- 4. self-test
Write-Host "self-test ..." -ForegroundColor White
& $vpy -X utf8 selftest.py
if ($LASTEXITCODE -eq 0) { Ok "self-test passed" } else { Warn "self-test reported problems (above) - the viewer may still run" }

Write-Host ""
Write-Host "Ready. Start the viewer: double-click run.bat (or: .\run.bat), then http://127.0.0.1:8770/" -ForegroundColor White
Write-Host "  your own data: set LOGVIEW_DATA=C:\path\to\DATASETS  then run.bat   - stop: the page's 'Close' button, or Ctrl-C"
