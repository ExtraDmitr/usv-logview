"""logview: the run viewer's local server (http://127.0.0.1:8770). Usage: ./run.sh [--port N] [--no-browser]
Read-only on the data, except the video cache (camera/<session>/.logview_cache/) and engine results cache beside it."""
import argparse, functools, json, os, re, sys, threading, time, traceback, urllib.parse, webbrowser
if os.name == "nt" and not sys.flags.utf8_mode:              # Windows: the logs are UTF-8; re-run in Python's UTF-8 mode
    import subprocess
    sys.exit(subprocess.call([sys.executable, "-X", "utf8", *sys.argv]))
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import core, depth, mapping  # noqa: E402
from engines import discover  # noqa: E402

ENGINES = discover()
_elock = threading.Lock()                     # one model call at a time (MPS / memory)


@functools.lru_cache(maxsize=6)
def bundle(rel):
    b = core.load_run(rel)
    for c in b["cams"]:
        c["depth_frames"] = sorted(depth.recorded_index(os.path.join(core.run_dir(rel), "camera", c["name"])))
    return b


@functools.lru_cache(maxsize=8)
def mapdata(rel, src=None):
    return core.load_map(rel, src)


def session_dir(q):
    sd = os.path.join(core.run_dir(q["rel"]), "camera", q["cam"])
    if not os.path.isdir(sd) or "/" in q["cam"] or ".." in q["cam"]:
        raise FileNotFoundError(q["cam"])
    return sd


def frame_record(rel, cam, i):
    c = next((c for c in bundle(rel)["cams"] if c["name"] == cam), None)
    return next((f for f in (c or {}).get("frames", []) if f.get("svo") == i), None)


def run_engine(name, q, i, img_cache):
    e = ENGINES[name]
    sd = session_dir(q)
    ctx = {"frame": frame_record(q["rel"], q["cam"], i), "session": sd, "frame_index": i}
    if name == "recorded":
        return e.run(None, ctx)
    if "img" not in img_cache:
        img_cache["img"] = core.frame_image(sd, i, "left")
    if e.kind == "attribute":
        base = q.get("base") or "recorded"
        ctx["boxes"] = run_engine(base, q, i, img_cache) if base != name else []
    with _elock:
        return e.run(img_cache["img"], ctx)


def cam_height(sd):
    """The camera's height above the water for the water plane: fitted once per session from the recorded neural depth, kept in index.json."""
    ix = core._index(sd)
    if "cam_h" not in ix:
        h = None
        try:
            c, _ = depth._conf(core._serial(sd)); K, _D = depth._cam(c, "LEFT", depth.RES.get(ix.get("w"), "2K"), 1.0)
            h = depth.fit_camera_height(sd, ix["h"], K[1, 1])
        except Exception:
            traceback.print_exc()
        core._save_index(sd, cam_h=h)
        ix = core._index(sd)
    return ix.get("cam_h") or 0.55


def depth_for(sd, i, src, mode, left=None, right=None):
    """(z metres, info) for frame i: recorded first when src is auto / recorded, else stereo (left / right raw frames may be given)."""
    z, info = (None, {})
    if src in ("auto", "recorded"):
        z, info = depth.recorded(sd, i)
    if z is None and src in ("auto", "stereo"):
        L = left if left is not None else core.frame_image(sd, i, "left_raw")
        R = right if right is not None else core.frame_image(sd, i, "right_raw")
        z, info = depth.stereo(L, R, serial=core._serial(sd), sdk=core._index(sd).get("sdk"), mode=mode, cam_h=cam_height(sd))
    return z, info


class DepthBuffer:
    """A sliding window of depth maps for ONE camera session (the page's "Buffer depth"): BEHIND frames before the cursor to AHEAD after,
    at reduced resolution (BUF_W wide), computed by one worker that reads the cached streams sequentially. Another session / source / mode
    -> everything is dropped and it starts over; stop() drops it too."""
    AHEAD, BEHIND, BUF_W = 240, 30, 560

    def __init__(self):
        self.lock = threading.Lock(); self.key = None; self.frames = {}; self.cursor = 0; self.n = 0; self.thread = None; self.stop_ev = threading.Event()
        self.err = None

    def start(self, sd, src, mode, cursor):
        key = (sd, src, mode)
        with self.lock:
            if key != self.key:
                self.stop_locked()
                self.key, self.frames, self.err = key, {}, None
                self.n = len(core._index(sd).get("ts") or [])
                self.stop_ev = threading.Event()
                self.thread = threading.Thread(target=self.run, args=(key, self.stop_ev), daemon=True); self.thread.start()
            self.cursor = int(cursor)
        return self.status()

    def stop_locked(self):
        self.stop_ev.set(); self.key = None; self.frames = {}

    def stop(self):
        with self.lock:
            self.stop_locked()

    def window(self):
        return max(0, self.cursor - self.BEHIND), min(self.n - 1, self.cursor + self.AHEAD)

    def status(self):
        with self.lock:
            if not self.key:
                return {"active": False}
            a, b = self.window(); r = self.cursor
            while r <= b and r in self.frames:
                r += 1
            return {"active": True, "cam": os.path.basename(self.key[0]), "src": self.key[1], "mode": self.key[2], "cursor": self.cursor,
                    "window": [a, b], "have": sum(1 for k in self.frames if a <= k <= b), "ready_upto": r - 1, "n": self.n, "error": self.err}

    def get(self, sd, src, mode, i):
        with self.lock:
            return self.frames.get(i) if self.key == (sd, src, mode) else None

    def run(self, key, stop_ev):
        import cv2, numpy as np
        sd, src, mode = key
        caps, last = {}, {}
        try:
            for eye in ("left_raw", "right_raw"):
                caps[eye] = cv2.VideoCapture(core.cache_paths(sd, eye)[1]); last[eye] = -1
            while not stop_ev.is_set():
                with self.lock:
                    a, b = self.window(); cur = self.cursor
                    for k in [k for k in self.frames if k < a or k > b]:
                        del self.frames[k]
                    todo = next((k for k in list(range(cur, b + 1)) + list(range(cur - 1, a - 1, -1)) if k not in self.frames), None)
                if todo is None:
                    time.sleep(0.15); continue
                L = R = None
                if not (src in ("auto", "recorded") and todo in depth.recorded_index(sd)) and src != "recorded":
                    imgs = {}
                    for eye, cap in caps.items():
                        if last[eye] != todo - 1:
                            cap.set(cv2.CAP_PROP_POS_FRAMES, todo)
                        ok, im = cap.read(); last[eye] = todo if ok else -1
                        imgs[eye] = im
                    L, R = imgs["left_raw"], imgs["right_raw"]
                z, info = depth_for(sd, todo, src, mode, L, R) if (L is not None or src != "stereo") else (None, {"error": "frame not readable"})
                if z is None:
                    entry = (None, info)
                else:
                    h = int(round(z.shape[0] * self.BUF_W / z.shape[1]))
                    zz = cv2.resize(z, (self.BUF_W, h), interpolation=cv2.INTER_NEAREST)
                    entry = (np.clip(zz * 1000.0, 0, 65535).astype("<u2").tobytes(), {**info, "w": self.BUF_W, "h": h, "frame": todo, "buffered": True})
                with self.lock:
                    if self.key == key:
                        self.frames[todo] = entry
        except Exception as e:
            traceback.print_exc(); self.err = str(e)
        finally:
            for c in caps.values():
                c.release()


DBUF = DepthBuffer()


class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        if os.environ.get("LOGVIEW_VERBOSE"):
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % tuple(str(x) for x in a)))

    def _send(self, code, body, ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, default=str).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path, ctype):
        size = os.path.getsize(path)
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else size - 1
                else:
                    start = size - int(m.group(2))
        end = min(end, size - 1)
        self.send_response(206 if rng else 200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if rng:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(1 << 20, left))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                left -= len(chunk)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path); q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        if u.path == "/api/depthbuf":
            try:
                sd = session_dir(q)
                for eye in ("left", "right"):
                    st = core.video_status(sd, eye, start=True)
                    if st.get("state") != "ready":
                        return self._send(202, {"state": st.get("state"), "done": st.get("done"), "total": st.get("total"), "note": f"caching the {eye} eye first"})
                return self._send(200, DBUF.start(sd, q.get("src", "auto"), q.get("mode", "plane"), int(q.get("cursor", 0))))
            except Exception as e:
                traceback.print_exc(); return self._send(500, {"error": str(e)})
        if u.path.startswith("/api/maplab/"):
            try:
                n = int(self.headers.get("Content-Length") or 0); body = json.loads(self.rfile.read(n) or b"{}") if n else {}
                if u.path == "/api/maplab/run":
                    b = bundle(q["rel"])
                    if not b.get("co"):
                        return self._send(400, {"error": "this run has no position origin"})
                    every = max(1.0, (b["t1"] - b["t0"]) / 1500.0)
                    return self._send(200, mapping.replay(core.run_dir(q["rel"]), b["co"], body.get("overrides") or {}, bool(body.get("use_guard")), every))
                if u.path == "/api/maplab/presets":
                    return self._send(200, {"saved": mapping.save_preset(body)})
                if u.path == "/api/maplab/presets/delete":
                    mapping.delete_preset(q.get("name")); return self._send(200, {"deleted": q.get("name")})
            except Exception as e:
                traceback.print_exc(); return self._send(500, {"error": str(e)})
        if u.path == "/api/depthbuf/stop":
            DBUF.stop(); return self._send(200, {"active": False})
        if urllib.parse.urlparse(self.path).path == "/api/quit":
            self._send(200, {"ok": True, "note": "server stopping"})
            print("quit requested from the page: stopping", flush=True)
            threading.Thread(target=self.server.shutdown, daemon=True).start()     # serve_forever() returns, main() exits
            return
        self._send(404, {"error": "not found"})

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        try:
            if u.path in ("/", "/index.html"):
                return self._file(os.path.join(HERE, "static", "index.html"), "text/html; charset=utf-8")
            if u.path.startswith("/static/"):
                p = os.path.normpath(os.path.join(HERE, u.path.lstrip("/")))
                if not p.startswith(os.path.join(HERE, "static")) or not os.path.isfile(p):
                    return self._send(404, {"error": "not found"})
                ct = {"js": "text/javascript", "css": "text/css", "html": "text/html", "svg": "image/svg+xml", "png": "image/png"}
                return self._file(p, ct.get(p.rsplit(".", 1)[-1], "application/octet-stream"))
            if u.path == "/api/runs":
                return self._send(200, core.list_runs())
            if u.path == "/api/run":
                return self._send(200, bundle(q["rel"]))
            if u.path == "/api/map":
                return self._send(200, mapdata(q["rel"], q.get("src") or None))
            if u.path == "/api/maplab/knobs":
                return self._send(200, mapping.knobs())
            if u.path == "/api/maplab/presets":
                return self._send(200, mapping.presets())
            if u.path == "/api/engines":
                out = []
                for n, e in ENGINES.items():
                    ok, why = e.available()
                    out.append({"name": n, "label": e.label, "kind": e.kind, "description": e.description, "colour": e.colour,
                                "available": ok, "reason": why, "options": {k: v for k, v in e.cfg.items() if not isinstance(v, (dict, list))}})
                order = ["recorded", "yolo_buoys", "cvnew", "lamp"]
                out.sort(key=lambda x: order.index(x["name"]) if x["name"] in order else 99)
                return self._send(200, out)
            if u.path == "/api/video/status":
                st = core.video_status(session_dir(q), q.get("eye", "left"), start=q.get("start") == "1")
                if st.get("state") == "ready":
                    _, _, idx = core.cache_paths(session_dir(q), q.get("eye", "left"))
                    st["index"] = json.load(open(idx))
                return self._send(200, st)
            if u.path == "/media":
                _, mp4, _ = core.cache_paths(session_dir(q), q.get("eye", "left"))
                if not os.path.exists(mp4):
                    return self._send(404, {"error": "video not cached yet"})
                return self._file(mp4, "video/mp4")
            if u.path == "/api/detect":
                i = int(q["frame"]); t0 = time.time()
                boxes = run_engine(q["engine"], q, i, {})
                return self._send(200, {"engine": q["engine"], "frame": i, "boxes": boxes, "ms": round(1000 * (time.time() - t0))})
            if u.path == "/api/depthbuf":
                return self._send(200, DBUF.status())
            if u.path == "/api/depth":
                sd = session_dir(q); i = int(q["frame"]); src = q.get("src", "auto"); mode = q.get("mode", "plane")
                if q.get("buf") == "1":                              # from the sliding buffer only: 204 = not computed yet
                    e = DBUF.get(sd, src, mode, i)
                    if e is None:
                        return self._send(204, b"", "text/plain")
                    if e[0] is None:
                        return self._send(404, e[1])
                    return self._send(200, e[0], "application/octet-stream", {"X-Depth-Info": json.dumps(e[1])})
                if src in ("auto", "stereo") and i not in depth.recorded_index(sd):
                    st = core.video_status(sd, "right", start=True)
                    if st.get("state") != "ready":
                        return self._send(202, {"state": st.get("state"), "done": st.get("done"), "total": st.get("total"),
                                                "note": "caching the right eye for stereo depth"})
                z, info = depth_for(sd, i, src, mode)
                if z is None:
                    return self._send(404, info)
                import numpy as np
                mm = np.clip(z * 1000.0, 0, 65535).astype("<u2")
                info.update({"w": int(mm.shape[1]), "h": int(mm.shape[0]), "frame": i})
                return self._send(200, mm.tobytes(), "application/octet-stream", {"X-Depth-Info": json.dumps(info)})
            return self._send(404, {"error": "not found"})
        except FileNotFoundError as e:
            return self._send(404, {"error": f"not found: {e}"})
        except Exception as e:
            traceback.print_exc()
            return self._send(500, {"error": str(e)})


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), H)
    url = f"http://127.0.0.1:{a.port}/"
    print(f"logview on {url}  (data: {core.DATASETS}; engines: {', '.join(ENGINES)})  Ctrl-C to stop", flush=True)
    if not a.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    srv.server_close()
    print("logview stopped", flush=True)


if __name__ == "__main__":
    main()
