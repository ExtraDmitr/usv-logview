"""Self-test: every run and console session loads, engines are available, and (when a cached video exists) recorded + lamp + depth
work on one frame. Usage: .venv/bin/python selftest.py   (exit code 1 on any failure)"""
import glob, json, os, sys, time
if os.name == "nt" and not sys.flags.utf8_mode:              # Windows: the logs are UTF-8; re-run in Python's UTF-8 mode
    import subprocess
    sys.exit(subprocess.call([sys.executable, "-X", "utf8", *sys.argv]))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import core, depth  # noqa: E402
from engines import discover  # noqa: E402

fail = []
t0 = time.time()
runs = core.list_runs()
for r in runs:
    try:
        b = core.load_run(r["path"]); core.load_map(r["path"])
        assert b["t1"] > b["t0"], "empty time span"
        for k, v in b["series"].items():
            assert len(v) == len(b["series"]["t"]), f"series {k} length"
        for name, spans in b["lanes"].items():
            assert all(s["t1"] >= s["t0"] for s in spans), f"lane {name} order"
    except Exception as e:
        fail.append(f"{r['path']}: {e!r}")
print(f"{len(runs)} runs / sessions loaded in {time.time() - t0:.1f} s, {len(fail)} failed")

E = discover()
for n, e in E.items():
    ok, why = e.available()
    if ok:
        print(f"engine {n}: ok")
    elif n == "recorded":
        fail.append(f"engine {n}: {why}")
    else:                                                      # optional: model weights / the team code are not everywhere
        print(f"engine {n}: not available here (optional; {why[:90]}{'...' if len(why) > 90 else ''})")

cached = glob.glob(os.path.join(core.DATASETS, "*", "*", "*", "camera", "*", core.CACHE, "left.mp4")) + \
    glob.glob(os.path.join(core.DATASETS, "*", "*", "camera", "*", core.CACHE, "left.mp4"))
cached = [c for c in cached if core._index(os.path.dirname(os.path.dirname(c)))]       # current-version caches only
if cached:
    sd = os.path.dirname(os.path.dirname(cached[0]))
    idx = core._index(sd)
    frames = [json.loads(l) for l in open(os.path.join(sd, "frames.jsonl"))]
    f = max(frames, key=lambda f: len(f.get("buoys") or []))
    img = core.frame_image(sd, f["svo_frame"])
    assert img.shape[:2] == (idx["h"], idx["w"]), "frame size"
    rec = E["recorded"].run(None, {"frame": f})
    lamp = E["lamp"].run(img, {"boxes": rec}) if "lamp" in E else []
    print(f"frame check {os.path.basename(sd)} #{f['svo_frame']}: {len(rec)} recorded boxes, {len(lamp)} lamp reads")
    di = depth.recorded_index(sd)
    if di:
        z, info = depth.recorded(sd, sorted(di)[0]); print(f"recorded depth {z.shape}, valid {100 * (z > 0).mean():.0f} %")
    ix = core._index(sd)
    print(f"geometry: {ix.get('geometry')} {ix.get('sdk')}")
    if os.path.exists(core.cache_paths(sd, "right_raw")[1]):
        z, info = depth.stereo(core.frame_image(sd, f["svo_frame"], "left_raw"), core.frame_image(sd, f["svo_frame"], "right_raw"), core._serial(sd), ix.get("sdk"))
        print(f"stereo depth {z.shape}, valid {info['valid_pct']} %")
else:
    print("no cached video yet: open a run with a camera once, then re-run for the frame checks")
try:
    import mapping
    rel = "3_venue/a_good/20261113_151110_m1t2-both_CV"
    if os.path.isdir(os.path.join(core.DATASETS, rel)):
        b = core.load_run(rel); r = mapping.replay(core.run_dir(rel), b["co"], {}, False)
        print(f"mapping lab replay: {r['stats']['items']} detections -> {r['stats']['buoys_final']} buoys in {r['stats']['seconds']} s, {len(mapping.presets())} presets")
except Exception as e:
    print(f"mapping lab: not available here (optional; {str(e)[:110]})")
for x in fail:
    print("FAIL", x)
sys.exit(1 if fail else 0)
