#!/usr/bin/env bash
# usv-logview quick install: prepares this laptop to run the viewer, everything Python-side inside ./.venv (nothing installed globally
# except, if missing and you agree, Python 3.10+ and ffmpeg from Homebrew / apt / dnf / pacman).
#
#   bash install.sh             full install (with the YOLO / CV_NEW engines: ultralytics + torch, ~1-2 GB)
#   bash install.sh --minimal   without the detection engines (viewer, camera, depth, charts, mapping lab)
#   bash install.sh --yes       do not ask (install missing system packages)
#   bash install.sh --fresh     delete and rebuild .venv
#   bash install.sh --check     only report what is there / missing
#
# macOS and Linux. Windows: use WSL (Ubuntu) and run it there.
set -euo pipefail
cd "$(dirname "$0")"
MINIMAL=0; YES=0; FRESH=0; CHECK=0
for a in "$@"; do
  case "$a" in
    --minimal) MINIMAL=1 ;; --yes|-y) YES=1 ;; --fresh) FRESH=1 ;; --check) CHECK=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $a (see --help)"; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }
ask()  { [ "$YES" = 1 ] && return 0; read -r -p "  $1 [Y/n] " r; [[ -z "$r" || "$r" =~ ^[Yy] ]]; }

OS="$(uname -s)"
PM=""
if [ "$OS" = Darwin ]; then command -v brew >/dev/null && PM=brew
else for p in apt-get dnf pacman; do command -v "$p" >/dev/null && { PM=$p; break; }; done; fi

pkg_install() {   # pkg_install <brew names> <apt names> <dnf names> <pacman names>
  case "$PM" in
    brew)    brew install $1 ;;
    apt-get) sudo apt-get update -qq && sudo apt-get install -y $2 ;;
    dnf)     sudo dnf install -y $3 ;;
    pacman)  sudo pacman -S --noconfirm $4 ;;
    *) return 1 ;;
  esac
}

bold "usv-logview install ($OS${PM:+, $PM})"

# ---- 1. Python 3.10+ with venv
find_python() {
  for c in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$c" >/dev/null && "$c" -c 'import sys, venv, ensurepip; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
      command -v "$c"; return 0
    fi
  done
  return 1
}
PY="$(find_python || true)"
if [ -n "$PY" ]; then ok "Python $("$PY" -c 'import platform; print(platform.python_version())') ($PY)"
else
  warn "no Python 3.10+ with venv found"
  [ "$CHECK" = 1 ] && exit 1
  if [ -n "$PM" ] && ask "install Python with $PM?"; then
    pkg_install "python@3.12" "python3 python3-venv python3-pip" "python3 python3-pip" "python python-pip" || fail "Python install failed"
    PY="$(find_python || true)"; [ -n "$PY" ] || fail "Python still not found - open a new terminal and run install.sh again"
    ok "Python $("$PY" -c 'import platform; print(platform.python_version())')"
  else
    fail "install Python 3.10+ (macOS: https://www.python.org/downloads/ or 'brew install python'; Ubuntu: 'sudo apt install python3 python3-venv') and run again"
  fi
fi

# ---- 2. ffmpeg (the video cache)
if command -v ffmpeg >/dev/null; then
  enc="$(ffmpeg -hide_banner -encoders 2>/dev/null || true)"
  if grep -q h264_videotoolbox <<<"$enc"; then ok "ffmpeg (hardware H.264 encoder)"
  elif grep -q libx264 <<<"$enc"; then ok "ffmpeg (libx264)"
  else warn "ffmpeg has no H.264 encoder (h264_videotoolbox / libx264): the camera cache will fail - install a full ffmpeg build"; fi
else
  warn "ffmpeg not found (needed to show the camera)"
  if [ "$CHECK" = 0 ] && [ -n "$PM" ] && ask "install ffmpeg with $PM?"; then
    pkg_install ffmpeg ffmpeg ffmpeg ffmpeg || warn "ffmpeg install failed - the viewer runs, the camera tile will not"
    command -v ffmpeg >/dev/null && ok "ffmpeg installed"
  else
    warn "continuing without ffmpeg (install it later: macOS 'brew install ffmpeg', Ubuntu 'sudo apt install ffmpeg')"
  fi
fi
[ "$CHECK" = 1 ] && { [ -x .venv/bin/python ] && ok ".venv present" || warn ".venv missing (run install.sh)"; exit 0; }

# ---- 3. the virtual environment
if [ "$FRESH" = 1 ] && [ -d .venv ]; then rm -rf .venv; ok "removed the old .venv"; fi
if [ -x .venv/bin/python ] && ! .venv/bin/python -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
  warn ".venv has an old Python - rebuilding"; rm -rf .venv
fi
if [ ! -x .venv/bin/python ]; then
  "$PY" -m venv .venv || fail "could not create .venv (Ubuntu: sudo apt install python3-venv)"
  ok "created .venv"
else ok "using the existing .venv"; fi
.venv/bin/python -m pip install -q --upgrade pip
bold "installing the Python packages into .venv ..."
.venv/bin/python -m pip install -q -r requirements.txt || fail "pip install -r requirements.txt failed"
ok "core packages (mcap, numpy, opencv, pillow, pyyaml, paho-mqtt)"
if [ "$MINIMAL" = 0 ]; then
  echo "  the detection engines (ultralytics + torch, a few minutes the first time) ..."
  if .venv/bin/python -m pip install -q -r requirements-ml.txt; then ok "detection engines (ultralytics, torch)"
  else warn "ultralytics / torch failed - the viewer works, the YOLO / CV_NEW engines will show as not available"; fi
else
  warn "--minimal: detection engines skipped (bash install.sh later adds them)"
fi
echo "$( [ "$MINIMAL" = 1 ] && echo minimal || echo full ) $(date '+%Y-%m-%d %H:%M')" > .venv/.logview_installed

# ---- 4. launchers + self-test
chmod +x run.sh install.sh 2>/dev/null || true
if [ "$OS" = Darwin ]; then
  cat > "Run Viewer.command" <<'EOF'
#!/bin/bash
# double-click in Finder: starts the Run Viewer and opens it in the browser (close the page's ✕ Close or this window to stop)
cd "$(dirname "$0")" && exec ./run.sh
EOF
  chmod +x "Run Viewer.command"; ok "'Run Viewer.command' (double-click in Finder)"
fi
bold "self-test ..."
if .venv/bin/python selftest.py; then ok "self-test passed"; else warn "self-test reported problems (above) - the viewer may still run"; fi

echo
bold "Ready. Start the viewer with:"
echo "  ./run.sh                                 # the included sample_data/"
echo "  LOGVIEW_DATA=/path/to/DATASETS ./run.sh  # your own data"
[ "$OS" = Darwin ] && echo "  or double-click 'Run Viewer.command'"
echo "  then http://127.0.0.1:8770/  (stop: ✕ Close in the page, or Ctrl-C)"
