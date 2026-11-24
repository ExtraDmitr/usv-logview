#!/bin/bash
# Run Viewer: ./run.sh [--port 8770] [--no-browser]   (first start creates .venv: mcap, numpy, opencv, pillow, ultralytics)
cd "$(dirname "$0")" || exit 1
if [ ! -x .venv/bin/python ]; then
  echo "creating .venv (one time, a few minutes: ultralytics / torch for the CV engines) ..."
  python3 -m venv .venv && .venv/bin/pip install -q --upgrade pip && .venv/bin/pip install -q mcap numpy opencv-python-headless pillow ultralytics pyyaml paho-mqtt || exit 1
fi
command -v ffmpeg >/dev/null || { echo "ffmpeg is needed for the video cache (brew install ffmpeg)"; exit 1; }
exec .venv/bin/python server.py "$@"
