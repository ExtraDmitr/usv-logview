"""Run loading for logview: one run folder of DATASETS -> a bundle the page draws (time series, timebar lanes, events, map replay,
camera sessions), and the camera video cache (.svo2 = MCAP + H.265 side-by-side -> left / right H.264 MP4 + a frame-time index).

All times are unix seconds (float). Folder names are local SGT; the boat CSV, the events file and frames.jsonl are UTC; ocs.log is SGT."""
import csv, datetime as dt, glob, json, math, os, re, subprocess, threading

# Where things are (override with environment variables): LOGVIEW_DATA = the DATASETS folder (default: two levels up, i.e. this tool
# lives in DATASETS/_tools/logview); ROBOTX = the folder holding DATASETS and MASTER_SCRIPTS; MASTER_SCRIPTS = the team's code (the mapping
# lab and the lamp reader import it). engines.json may use ${DATASETS}, ${ROBOTX}, ${MASTER_SCRIPTS}.
_HERE = os.path.dirname(os.path.abspath(__file__))
DATASETS = os.path.abspath(os.environ.get("LOGVIEW_DATA") or next(
    (p for p in (os.path.join(_HERE, "..", ".."), os.path.join(_HERE, "sample_data")) if os.path.exists(os.path.join(p, "index.csv"))),
    os.path.join(_HERE, "..", "..")))                             # a fresh clone of the repo: its sample_data/
os.environ.setdefault("DATASETS", DATASETS)
os.environ.setdefault("ROBOTX", os.path.dirname(DATASETS))
os.environ.setdefault("MASTER_SCRIPTS", os.path.join(os.environ["ROBOTX"], "MASTER_SCRIPTS"))


def expand(p):
    return os.path.expanduser(os.path.expandvars(p)) if isinstance(p, str) else p


_ENC = None


def h264_args():
    """The H.264 encoder for the video cache: Apple's hardware encoder on a Mac, else libx264."""
    global _ENC
    if _ENC is None:
        enc = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
        _ENC = ["-c:v", "h264_videotoolbox", "-b:v", "8M"] if "h264_videotoolbox" in enc else ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
    return _ENC + ["-g", "15", "-movflags", "+faststart"]
SGT = dt.timezone(dt.timedelta(hours=8))
CACHE = ".logview_cache"


# ------------------------------------------------------------------ the run list
def list_runs():
    rows = list(csv.DictReader(open(os.path.join(DATASETS, "index.csv"))))
    for r in rows:
        r["path"] = os.path.join(r["category"], r["run"]); r["kind"] = "run"
    rows = [r for r in rows if os.path.isdir(os.path.join(DATASETS, r["path"]))]
    # boat-console sessions (usv_ui: <stem>.csv + .events [+ .tlog]) outside run folders: pool 3, the console logs
    for dp, ds, fs in os.walk(DATASETS):
        relp = os.path.relpath(dp, DATASETS)
        ds[:] = [x for x in ds if not (x.startswith(("_tools", "_labels", "_other", ".")) or x in ("motion", "camera", "operator"))]
        for f in sorted(fs):
            if f.endswith(".csv") and f[:-4] + ".events" in fs:
                m = re.search(r"(20\d{6})-(\d{6})Z", f)
                t = dt.datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S").replace(tzinfo=dt.timezone.utc).astimezone(SGT) if m else None
                rows.append({"category": relp, "run": f[:-4], "path": os.path.join(relp, f), "kind": "console",
                             "date": t.strftime("%Y-%m-%d") if t else "", "start": t.strftime("%H:%M:%S") if t else "", "mission": "console session",
                             "cv": "", "motion": "console", "dur_s": "", "dist_m": "", "armed_s": "", "cam_sessions": "0", "frames": "0",
                             "frames_with_buoys": "0", "ranged_buoys": "0", "lamp_reads": "0", "svo_GB": "0",
                             "note": "the boat console's own session log (csv, events, tlog)" + (" — simulated" if "sim" in f else "")})
    return rows


def run_dir(rel):
    p = os.path.abspath(os.path.join(DATASETS, rel))
    if not p.startswith(DATASETS + os.sep) or not (os.path.isdir(p) or (p.endswith(".csv") and os.path.isfile(p))):
        raise FileNotFoundError(rel)
    return p


def _iso(s):
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def _name_time(name):
    m = re.search(r"(20\d{6})_(\d{6})", name or "")
    return dt.datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S").replace(tzinfo=SGT).timestamp() if m else None


def _num(v):
    try:
        x = float(v)
        return x if math.isfinite(x) else None
    except Exception:
        return None


# ------------------------------------------------------------------ geometry
def ll_to_local(lat, lon, co):
    """lat/lon -> (north, east) metres from the origin co (equirectangular, fine over a course)."""
    return ((lat - co[0]) * 111320.0, (lon - co[1]) * 111320.0 * math.cos(math.radians(co[0])))


# ------------------------------------------------------------------ the bundle
SERIES = {  # csv column -> (group, label, unit)
    "gs": ("speed", "ground speed", "m/s"), "vn": ("speed", "v north", "m/s"), "ve": ("speed", "v east", "m/s"),
    "hdg": ("heading", "heading", "deg"),
    "c1": ("commands", "cmd 1", ""), "c2": ("commands", "cmd 2", ""), "c3": ("commands", "cmd 3", ""), "c4": ("commands", "cmd 4", ""),
    "s1": ("outputs", "servo 1", ""), "s2": ("outputs", "servo 2", ""), "s3": ("outputs", "servo 3", ""), "s4": ("outputs", "servo 4", ""),
    "wp_dist": ("path", "distance to waypoint", "m"), "path_xte": ("path", "cross-track error", "m"),
    "sats": ("gnss", "satellites", ""), "hdop": ("gnss", "HDOP", ""), "fix": ("gnss", "fix type", ""),
}


def _lanes_from_steps(steps, t_end):
    """[(t, value), ...] (value changes) -> [{t0, t1, v}] spans."""
    out = []
    for i, (t, v) in enumerate(steps):
        t1 = steps[i + 1][0] if i + 1 < len(steps) else t_end
        if v not in (None, "") and t1 > t:
            out.append({"t0": t, "t1": t1, "v": str(v)})
    return out


def _changes(rows):
    st, last = [], object()
    for t, v in rows:
        if v != last:
            st.append((t, v)); last = v
    return st


def load_run(rel):
    d = run_dir(rel)
    console = d.endswith(".csv")
    G = (lambda *a: []) if console else (lambda *a: glob.glob(os.path.join(d, *a)))
    info = {"category": os.path.dirname(rel), "mission": "console session", "motion": "the boat console's csv / events / tlog",
            "note": "a boat-console session (no mission manager, camera or map in this file set)"} if console else \
        (json.load(open(os.path.join(d, "run.json"))) if os.path.exists(os.path.join(d, "run.json")) else {})
    b = {"run": os.path.basename(d), "rel": rel, "info": {k: info.get(k) for k in ("category", "mission", "note", "motion", "boat", "cv_tag")}, "runjson": info,
         "series": {}, "series_meta": {}, "lanes": {}, "events": [], "track": [], "cams": [], "co": None, "has_map": False}
    t_all = []

    # boat CSV (10 Hz): series, the track, FCU mode / armed lanes
    csvs = [d] if console else G("motion", "*", "*_run.csv")
    if csvs:
        T, cols, modes, armed, trk = [], {k: [] for k in SERIES}, [], [], []
        name_t = None if console else _name_time(os.path.basename(os.path.dirname(csvs[0])))
        mono0 = None
        for row in csv.DictReader(open(csvs[0], errors="ignore")):
            t = _iso(row.get("utc", ""))
            if t is None:                                   # no GPS time (indoors): the monotonic clock from the folder's start time
                m = _num(row.get("t_mono"))
                if m is None or name_t is None:
                    continue
                mono0 = m if mono0 is None else mono0
                t = name_t + (m - mono0)
            T.append(round(t, 3))
            for k in SERIES:
                cols[k].append(_num(row.get(k)))
            modes.append((t, row.get("mode") or None))
            armed.append((t, "ARMED" if row.get("armed") == "1" else "disarmed"))
            la, lo = _num(row.get("lat")), _num(row.get("lon"))
            if la and lo:
                trk.append([round(t, 2), la, lo, _num(row.get("hdg")), row.get("mode") or ""])
        if T:
            b["series"]["t"] = T
            for k, v in cols.items():
                if any(x is not None for x in v):
                    b["series"][k] = v; b["series_meta"][k] = SERIES[k]
            b["lanes"]["FCU mode"] = _lanes_from_steps(_changes(modes), T[-1])
            b["lanes"]["armed"] = [s for s in _lanes_from_steps(_changes(armed), T[-1]) if s["v"] == "ARMED"]
            b["track"] = trk
            t_all += [T[0], T[-1]]

    # mission manager trace: state / task lanes, mode requests
    for mt in G("motion", "*", "mm_trace.jsonl"):
        t0, st, tk, end = None, [], [], None
        for line in open(mt, errors="ignore"):
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("k") == "start":
                t0 = r.get("unix") or _name_time(os.path.basename(os.path.dirname(mt)))
                continue
            if t0 is None:
                continue
            t = t0 + r.get("t", 0); end = t
            if r.get("k") == "obs":
                st.append((t, r.get("state"))); tk.append((t, "/".join(x for x in (r.get("task"), r.get("sub")) if x) or None))
            elif r.get("k") == "mode_req":
                b["events"].append({"t": t, "src": "mission", "text": f"mode request {r.get('mode')} ({'ok' if r.get('ok') else 'refused'})"})
        if end:
            b["lanes"]["mission state"] = _lanes_from_steps(_changes(st), end)
            b["lanes"]["task"] = _lanes_from_steps(_changes(tk), end)
            t_all += [end]

    # the console's event file (UTC iso, mono, text)
    for ev in ([d[:-4] + ".events"] if console else G("motion", "*", "*_run.events")):
        for line in open(ev, errors="ignore"):
            p = line.rstrip("\n").split(",", 2)
            t = _iso(p[0]) if p else None
            if t and len(p) == 3 and not p[2].startswith(("settings", "logging", "CO loaded", "usv_ui kit")):
                b["events"].append({"t": t, "src": "boat", "text": p[2][:200]})

    # the operator station: RoboCommand run states (declared, running ...), commands
    for ol in G("operator", "run_*", "ocs.log"):
        steps = []
        for line in open(ol, errors="ignore"):
            m = re.match(r"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),(\d+) \S+ \w+ (.*)", line)
            if not m:
                continue
            t = dt.datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S").replace(tzinfo=SGT).timestamp() + int(m.group(2)) / 1000
            txt = m.group(3)
            rs = re.match(r"run: (\w+) -> (\w+)", txt)
            if rs:
                steps.append((t, rs.group(2)))
                b["events"].append({"t": t, "src": "operator", "text": txt[:200]})
            elif re.search(r"cmd -> |DECLAR|ABORT|ARM|launch preset", txt):
                b["events"].append({"t": t, "src": "operator", "text": txt[:200]})
        if steps:
            end = max(t_all) if t_all else steps[-1][0] + 60
            b["lanes"]["run (judge)"] = _lanes_from_steps(steps, max(end, steps[-1][0] + 1))
            t_all += [steps[0][0]]

    # camera sessions
    for sd in sorted(G("camera", "*")):
        fr = os.path.join(sd, "frames.jsonl")
        c = {"name": os.path.basename(sd), "svo": bool(glob.glob(os.path.join(sd, "*.svo2")) or glob.glob(os.path.join(sd, "*.svo2.part00"))),
             "frames": [], "obs_t": [], "obs_n": []}
        if os.path.exists(os.path.join(sd, "session.json")):
            s = json.load(open(os.path.join(sd, "session.json")))
            c["opts"] = s.get("options", {}); c["model"] = (s.get("versions") or {}).get("weights")
        if os.path.exists(fr):
            for line in open(fr, errors="ignore"):
                try:
                    f = json.loads(line)
                except Exception:
                    continue
                t = (f.get("ts_ns") or 0) / 1e9 or (_iso(f["t"]) if isinstance(f.get("t"), str) else None)
                if not t:
                    continue
                c["obs_t"].append(round(t, 3)); c["obs_n"].append(f.get("n_buoys") or 0)
                c["frames"].append({"t": round(t, 3), "svo": f.get("svo_frame"), "lat": f.get("lat"), "lon": f.get("lon"),
                                    "hdg": f.get("heading_deg"), "status": f.get("status"), "buoys": f.get("buoys") or []})
        c["video"] = _index(sd) or None
        if c["obs_t"]:
            t_all += [c["obs_t"][0], c["obs_t"][-1]]
        b["cams"].append(c)
    if any(c["obs_t"] for c in b["cams"]):
        b["series_meta"]["_obs"] = ("perception", "buoys in view", "")

    # the map recording (boat first, else the operator's): origin
    mp = G("motion", "*", "maps", "*_map.jsonl") + G("operator", "maps", "*_map.jsonl")
    if mp:
        h = json.loads(open(mp[0]).readline())
        if h.get("co"):
            b["co"] = [h["co"]["lat"], h["co"]["lon"]]; b["has_map"] = True
    if b["co"] is None:
        ll = [(p[1], p[2]) for p in b["track"]] + [(f["lat"], f["lon"]) for c in b["cams"] for f in c["frames"] if f.get("lat")]
        if ll:
            b["co"] = [ll[0][0], ll[0][1]]
    if b["co"]:
        co = b["co"]
        b["track"] = [[t, *[round(v, 2) for v in ll_to_local(la, lo, co)], h, m] for t, la, lo, h, m in b["track"]]
        for c in b["cams"]:                                   # geolocate ranged detections
            for f in c["frames"]:
                if f.get("lat") and f.get("hdg") is not None:
                    n0, e0 = ll_to_local(f["lat"], f["lon"], co)
                    f["xy"] = [round(n0, 2), round(e0, 2)]
                    hr = math.radians(f["hdg"])
                    for bo in f["buoys"]:
                        fw, rt = bo.get("forward_m"), bo.get("right_m")
                        if fw is not None and rt is not None:
                            bo["xy"] = [round(n0 + fw * math.cos(hr) - rt * math.sin(hr), 2), round(e0 + fw * math.sin(hr) + rt * math.cos(hr), 2)]
        if not b["track"]:                                    # pose-only runs: the track from the camera frames
            b["track"] = [[f["t"], f["xy"][0], f["xy"][1], f["hdg"], ""] for c in b["cams"] for f in c["frames"] if f.get("xy")]
    b["map_sources"] = [] if console else [s_ for s_, g in (("boat", ("motion", "*", "maps", "*_map.jsonl")), ("operator", ("operator", "maps", "*_map.jsonl"))) if G(*g)]
    b["events"].sort(key=lambda e: e["t"])
    t_all += [e["t"] for e in b["events"][:1]] + [e["t"] for e in b["events"][-1:]]
    if not t_all:
        nt = _name_time(b["run"])
        t_all = [nt] if nt else [0]
    b["t0"], b["t1"] = min(t_all), max(max(t_all), min(t_all) + 1)
    return b


def load_map(rel, src=None):
    """A recorded map, compacted: [{t, boat, ent: [[id, kind, colour, n, e, state, source, light, n_obs, sigma]], path, carrot, gates, bnd,
    markers}]. src: boat (the boat's own map recording) | operator (the shore's) | None = boat, else operator."""
    d = run_dir(rel)
    if d.endswith(".csv"):
        return []
    boat = glob.glob(os.path.join(d, "motion", "*", "maps", "*_map.jsonl")); opr = glob.glob(os.path.join(d, "operator", "maps", "*_map.jsonl"))
    mp = boat if src == "boat" else opr if src == "operator" else (boat or opr)
    out = []
    if not mp:
        return out
    for line in open(mp[0], errors="ignore"):
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("k") != "frame":
            continue
        m = r.get("map") or {}
        bo = m.get("boat") or {}
        out.append({"t": r["t"], "boat": [bo.get("x_n"), bo.get("y_e"), bo.get("hdg_deg")],
                    "ent": [[e.get("id"), e.get("kind"), e.get("colour"), e.get("x_n"), e.get("y_e"), e.get("state"), e.get("source"),
                             e.get("light"), e.get("n_obs"), e.get("sigma_m")] for e in m.get("entities") or []],
                    "path": m.get("path") or [], "carrot": m.get("carrot"), "gates": m.get("gates") or [], "bnd": m.get("course_boundary_local") or [],
                    "markers": m.get("markers"), "task": m.get("task"), "task_state": m.get("task_state")})
    return out


# ------------------------------------------------------------------ the camera video cache
# Streams per camera session (camera/<s>/.logview_cache/):
#   left_raw.mp4 / right_raw.mp4 - the eyes exactly as stored in the .svo2 (unrectified; for stereo depth)
#   left.mp4 - the left eye in the ZED SDK's rectified geometry: undistorted with the factory calibration, then a small similarity
#              (shift, rotation, scale) registered on this session's own SDK images (pairs/rgb_*.jpg). This is the image the boat's
#              detector saw: recorded boxes and recorded depth align with it natively. Shown in the viewer; fed to the CV engines.
#   index.json - fps, ts (unix s per frame), w, h, codec, layout, geometry, version
_jobs, _lock = {}, threading.Lock()
CACHE_VERSION = 2
DEFAULT_SDK = {"scale": 1.0035, "rot_deg": -0.08, "dx_frac": 3.2 / 960, "dy_frac": -5.9 / 960}   # median over 9 registrations (12-13 Nov)


def _svo(sd):
    """The session's .svo2; one split into parts (cam.svo2.part00, part01 ... - the repo's sample data, GitHub's 100 MB limit) is joined
    once into the cache folder."""
    f = glob.glob(os.path.join(sd, "*.svo2"))
    if f:
        return f[0]
    parts = sorted(glob.glob(os.path.join(sd, "*.svo2.part[0-9][0-9]")))
    if not parts:
        return None
    joined = os.path.join(sd, CACHE, os.path.basename(parts[0])[:-len(".part00")])
    if not os.path.exists(joined) or os.path.getsize(joined) != sum(os.path.getsize(p) for p in parts):
        os.makedirs(os.path.dirname(joined), exist_ok=True)
        with open(joined + ".part", "wb") as out:
            for p in parts:
                with open(p, "rb") as fh:
                    while True:
                        b = fh.read(1 << 22)
                        if not b:
                            break
                        out.write(b)
        os.replace(joined + ".part", joined)
    return joined


def cache_paths(sd, eye="left"):
    c = os.path.join(sd, CACHE)
    name = {"left": "left", "right": "right_raw", "left_raw": "left_raw", "right_raw": "right_raw"}[eye]
    return c, os.path.join(c, f"{name}.mp4"), os.path.join(c, "index.json")


def _index(sd):
    p = os.path.join(sd, CACHE, "index.json")
    if not os.path.exists(p):
        return {}
    d = json.load(open(p))
    return d if d.get("version") == CACHE_VERSION else {}


def _save_index(sd, **kw):
    p = os.path.join(sd, CACHE, "index.json")
    d = _index(sd); d.update(kw, version=CACHE_VERSION)
    json.dump(d, open(p + ".part", "w")); os.replace(p + ".part", p)


def _extract_raw_eye(sd, eye, key):
    """svo2 -> the raw H.265 / H.264 stream (MCAP side_by_side, 8-byte header stripped) -> ffmpeg crop one eye -> <eye>_raw.mp4."""
    from mcap.reader import make_reader
    c, mp4, _ = cache_paths(sd, eye + "_raw")
    os.makedirs(c, exist_ok=True)
    svo = _svo(sd)
    summ = make_reader(open(svo, "rb")).get_summary()
    topic = next(ch.topic for ch in summ.channels.values() if ch.topic.endswith("side_by_side"))
    n_total = next((n for cid, n in summ.statistics.channel_message_counts.items() if summ.channels[cid].topic == topic), 0)
    raw = os.path.join(c, f"{eye}.raw")
    ts, fmt = [], None
    with open(raw, "wb") as o:
        for _, ch, msg in make_reader(open(svo, "rb")).iter_messages(topics=[topic]):
            d = msg.data[8:]
            if fmt is None:                                       # the codec from the first NAL unit: H.265 (VPS 32..34) or H.264 (SPS 7)
                i = d.find(b"\x00\x00\x01")
                nal = d[i + 3] if i >= 0 and i + 3 < len(d) else 0
                fmt = "hevc" if ((nal >> 1) & 0x3F) in (32, 33, 34, 19, 20, 1) and (nal & 0x1F) != 7 else "h264"
            o.write(d); ts.append(msg.log_time / 1e9)
            if len(ts) % 200 == 0:
                _jobs[key] = {"state": f"extracting {eye}", "done": len(ts), "total": n_total}
    probe = subprocess.run(["ffprobe", "-v", "error", "-f", fmt, "-select_streams", "v:0", "-show_entries", "stream=width,height",
                            "-of", "csv=p=0", raw], capture_output=True, text=True).stdout.strip().split(",")
    FW, FH = int(probe[0]), int(probe[1])
    if FW > 2.5 * FH:                                             # side by side (FHD / HD recordings): left | right
        W, H = FW // 2, FH
        crop = f"crop={W}:{H}:{0 if eye == 'left' else W}:0"
    else:                                                         # stacked (hd2k recordings): left over right
        W, H = FW, FH // 2
        crop = f"crop={W}:{H}:0:{0 if eye == 'left' else H}"
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", fmt, "-r", "15", "-i", raw, "-vf", crop, *h264_args(),
                          "-progress", "pipe:1", "-nostats", mp4 + ".part.mp4"],
                         stdout=subprocess.PIPE, text=True)
    for line in p.stdout:
        if line.startswith("frame="):
            _jobs[key] = {"state": f"caching the raw {eye} eye", "done": int(line.split("=")[1]), "total": len(ts)}
    if p.wait() != 0:
        raise RuntimeError("ffmpeg failed")
    os.replace(mp4 + ".part.mp4", mp4)
    os.remove(raw)
    _save_index(sd, fps=15, ts=[round(t, 4) for t in ts], w=W, h=H, codec=fmt, layout="side_by_side" if FW > 2.5 * FH else "stacked")


def _sdk_transform(sd, W, H, K, D):
    """The SDK's rectified left = A * (the undistorted raw left, same K). A (2x3, full resolution) is registered on this session's own
    SDK images (pairs/rgb_*.jpg) when there are some, else the default; returns (A, description)."""
    import cv2, numpy as np
    pairs_f = os.path.join(sd, "pairs", "pairs.jsonl")
    fits = []
    if os.path.exists(pairs_f):
        pairs = [json.loads(l) for l in open(pairs_f)]
        orb = cv2.ORB_create(4000); bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
        for pr in pairs[2:14:2]:
            try:
                sdk = cv2.imread(os.path.join(sd, "pairs", pr["rgb"]))
                raw = frame_image(sd, pr["svo_frame"], "left_raw")
                h, w = sdk.shape[:2]
                und = cv2.resize(cv2.undistort(raw, K, D, None, K), (w, h), interpolation=cv2.INTER_AREA)
                ka, da = orb.detectAndCompute(cv2.cvtColor(sdk, cv2.COLOR_BGR2GRAY), None)
                kb, db = orb.detectAndCompute(cv2.cvtColor(und, cv2.COLOR_BGR2GRAY), None)
                m = bf.match(da, db)
                pa = np.float32([ka[x.queryIdx].pt for x in m]); pb = np.float32([kb[x.trainIdx].pt for x in m])
                M, inl = cv2.estimateAffinePartial2D(pb, pa, ransacReprojThreshold=2.0)
                if M is None or inl.sum() < 200:
                    continue
                res = float(np.median(np.linalg.norm((pb @ M[:, :2].T + M[:, 2]) - pa, axis=1)[inl.ravel() > 0]))
                fits.append((np.hypot(M[0, 0], M[1, 0]), np.degrees(np.arctan2(M[1, 0], M[0, 0])), M[0, 2] / w, M[1, 2] / w, res))
            except Exception:
                continue
    if len(fits) >= 2:
        f = np.median(np.array(fits), axis=0)
        sc, rot, dxf, dyf, res = (float(x) for x in f)
        desc = f"registered on {len(fits)} of this session's SDK images (residual {res:.1f} px at 960 wide)"
    else:
        sc, rot, dxf, dyf = DEFAULT_SDK["scale"], DEFAULT_SDK["rot_deg"], DEFAULT_SDK["dx_frac"], DEFAULT_SDK["dy_frac"]
        desc = "default SDK transform (this session has no saved SDK images to register on)"
    # the similarity at the pairs' scale maps (u, v) of a w-wide image; at full resolution the rotation / scale stay, the shift scales
    c, s_ = sc * np.cos(np.radians(rot)), sc * np.sin(np.radians(rot))
    A = np.array([[c, -s_, dxf * W], [s_, c, dyf * W]])
    return A, desc, {"scale": round(sc, 5), "rot_deg": round(rot, 4), "shift_px": [round(dxf * W, 2), round(dyf * W, 2)]}


def _build_left_sdk(sd, key):
    """left_raw.mp4 -> (undistort + the SDK transform, one remap per frame) -> left.mp4."""
    import cv2, numpy as np
    import depth
    ix = _index(sd); W, H = ix["w"], ix["h"]
    c, mp4, _ = cache_paths(sd, "left")
    cal, cname = depth._conf(_serial(sd))
    K, D = depth._cam(cal, "LEFT", depth.RES.get(W, "2K"), 1.0)
    _jobs[key] = {"state": "registering on the SDK images", "done": 0, "total": len(ix["ts"])}
    A, desc, params = _sdk_transform(sd, W, H, K, D)
    newK = np.vstack([A, [0, 0, 1]]) @ K                          # SDK pixel = A * K * x_normalised
    mx, my = cv2.initUndistortRectifyMap(K, D, np.eye(3), newK, (W, H), cv2.CV_16SC2)
    dec = subprocess.Popen(["ffmpeg", "-v", "error", "-i", cache_paths(sd, "left_raw")[1], "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                           stdout=subprocess.PIPE)
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", "15", "-i", "-",
                            *h264_args(), mp4 + ".part.mp4"],
                           stdin=subprocess.PIPE)
    n, fb = 0, W * H * 3
    while True:
        buf = dec.stdout.read(fb)
        if len(buf) < fb:
            break
        im = np.frombuffer(buf, np.uint8).reshape(H, W, 3)
        enc.stdin.write(cv2.remap(im, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT).tobytes())
        n += 1
        if n % 20 == 0:
            _jobs[key] = {"state": "rectifying the left eye (ZED SDK geometry)", "done": n, "total": len(ix["ts"])}
    enc.stdin.close(); dec.wait()
    if enc.wait() != 0:
        raise RuntimeError("ffmpeg (encode) failed")
    os.replace(mp4 + ".part.mp4", mp4)
    _save_index(sd, geometry=desc, sdk=params, calib=cname)


def _serial(sd):
    try:
        return (json.load(open(os.path.join(sd, "session.json"))).get("versions") or {}).get("camera_serial")
    except Exception:
        return None


def build_video(sd, eye="left"):
    """Build the cache streams one eye needs (runs in a thread; progress in _jobs[(sd, eye)])."""
    key = (sd, eye)
    try:
        if not _index(sd):                                        # an old (v1) or no cache: its videos / index rebuilt from scratch
            for f in glob.glob(os.path.join(sd, CACHE, "*")):
                if not f.endswith(".svo2"):                       # keep a joined recording (split sample data)
                    os.remove(f)
        base = "right" if eye in ("right", "right_raw") else "left"
        if not os.path.exists(cache_paths(sd, base + "_raw")[1]) or not _index(sd).get("ts"):
            _extract_raw_eye(sd, base, key)
        if eye == "left" and not os.path.exists(cache_paths(sd, "left")[1]):
            _build_left_sdk(sd, key)
        _jobs[key] = {"state": "ready"}
    except Exception as e:
        import traceback; traceback.print_exc()
        _jobs[key] = {"state": "error", "error": str(e)}


def video_status(sd, eye="left", start=False):
    key = (sd, eye)
    _, mp4, _ = cache_paths(sd, eye)
    if os.path.exists(mp4) and _index(sd).get("ts"):
        return {"state": "ready"}
    if not (glob.glob(os.path.join(sd, "*.svo2")) or glob.glob(os.path.join(sd, "*.svo2.part00"))):     # cheap: no joining here
        return {"state": "none"}
    with _lock:
        j = _jobs.get(key)
        if start and (j is None or j.get("state") in ("error", "ready")):
            _jobs[key] = {"state": "starting", "done": 0, "total": 0}
            threading.Thread(target=build_video, args=(sd, eye), daemon=True).start()
    return _jobs.get(key, {"state": "missing"})


def frame_image(sd, i, eye="left"):
    """One full-resolution frame (BGR numpy) from a cached stream (left = SDK geometry, left_raw / right_raw = as recorded)."""
    import cv2
    _, mp4, _ = cache_paths(sd, eye)
    cap = cv2.VideoCapture(mp4)
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(i))
    ok, im = cap.read()
    cap.release()
    if not ok:
        raise ValueError(f"frame {i} of {eye} not readable")
    return im
