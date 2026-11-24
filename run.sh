#!/bin/bash
# Run Viewer: ./run.sh [--port 8770] [--no-browser]   (no .venv yet -> runs install.sh first)
cd "$(dirname "$0")" || exit 1
if [ ! -x .venv/bin/python ]; then
  echo "first start: preparing this laptop (install.sh) ..."
  bash install.sh || exit 1
fi
command -v ffmpeg >/dev/null || echo "note: ffmpeg not found - the camera tile will not work (bash install.sh offers to install it)"
exec .venv/bin/python server.py "$@"
