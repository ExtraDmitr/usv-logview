"""The mapping lab: replay a run's camera detections through the boat's own PerceptionMap (MASTER_SCRIPTS/optiprimex/usv/perception_map.py,
fed by cv/publish/cv_publish.frame_to_items exactly as on the boat - the 14 Nov replay recipe, _labels/cv_review/replay_map_2026-11-14)
with the course profile's knobs overridden, and return the map as it would have looked every second.

Knob overrides are dotted paths into the profile YAML (perception.min_obs, map.assoc_gate_m, perception.merge.a ...), applied before the
boat's own config loader (companion.config.from_dict), so the lab never changes MASTER_SCRIPTS. Presets: presets/mapping/<name>.json."""
import copy, glob, importlib.util, json, math, os, re, sqlite3, sys, threading, time, types

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(HERE, "engines.json"))).get("mapping", {}) if os.path.exists(os.path.join(HERE, "engines.json")) else {}
_x = lambda p: os.path.expanduser(os.path.expandvars(p))
MS = _x(CFG.get("master_scripts", "${MASTER_SCRIPTS}"))           # ${MASTER_SCRIPTS} is set by core.py (see there)
PROFILE = _x(CFG.get("profile", os.path.join(MS, "profiles/course/usv_course.yaml")))
PRESETS = os.path.join(HERE, "presets", "mapping")
_lock = threading.Lock()
_mods = {}

# key, group, label, type, min, max, step, explanation
KNOBS = [
    ("map.min_conf", "Detections", "min confidence", float, 0, 1, 0.05, "Detections below this confidence are ignored by the map."),
    ("perception.ranged_max_m", "Detections", "ranged max (m)", float, 0, 30, 0.5, "A buoy's depth range beyond this counts as a bearing only (a ray, never a position). 0 = off. Far depth near the 25 m clip placed buoys wrongly on 13 Nov."),
    ("map.assoc_gate_m", "Association", "gate (m)", float, 0.2, 6, 0.1, "A sighting within this distance of a tracked buoy of the same kind updates it; else a new buoy is created. Too small = one buoy becomes several; too large = neighbours fuse."),
    ("perception.assoc_gate_a", "Association", "range gate a (m)", float, 0, 2, 0.05, "> 0 = the gate grows with range: a + b x range, clamped to [min, max] (replaces the fixed gate for ranged sightings). 0 = off."),
    ("perception.assoc_gate_b", "Association", "range gate b (m/m)", float, 0, 0.3, 0.01, "Range gate slope: metres of gate per metre of range."),
    ("perception.assoc_gate_min", "Association", "range gate min (m)", float, 0.2, 3, 0.1, "Range gate lower clamp."),
    ("perception.assoc_gate_max", "Association", "range gate max (m)", float, 0.5, 6, 0.1, "Range gate upper clamp."),
    ("perception.assoc_colour_m", "Association", "colour separation (m)", float, 0, 30, 0.5, "Within this range a sighting lit red / green / blue never joins a buoy decided another of those colours. 0 = off."),
    ("map.ema_n_max", "Association", "position memory (n)", int, 1, 50, 1, "Position = running average with weight 1/min(n_obs, this): higher = steadier, slower to correct."),
    ("perception.min_obs", "Ghost filter", "min sightings", int, 1, 30, 1, "A buoy seen fewer times stays internal: not on the map, not a gate, not a target. The main ghost filter."),
    ("perception.forget_s", "Ghost filter", "forget young (s)", float, 0, 60, 0.5, "A young buoy (below min sightings) not seen again for this long is dropped. 0 = only the normal ageing."),
    ("perception.max_age_s", "Ageing", "stale after (s)", float, 5, 1200, 5, "Not seen for this long -> stale (kept faint on the map, no longer a gate)."),
    ("perception.drop_age_s", "Ageing", "drop after (s)", float, 10, 1800, 10, "Stale for this long -> removed."),
    ("perception.merge.enabled", "Merge pass", "merge buoys", bool, 0, 1, 1, "Once a second, two mapped buoys closer than the merge radius become one (the better-seen keeps its id)."),
    ("perception.merge.a", "Merge pass", "radius a (m)", float, 0, 3, 0.05, "Merge radius = a + b x (the closest range either buoy was seen from), clamped [min, max]."),
    ("perception.merge.b", "Merge pass", "radius b (m/m)", float, 0, 0.3, 0.01, "Merge radius slope."),
    ("perception.merge.min_m", "Merge pass", "radius min (m)", float, 0, 3, 0.1, "Merge radius lower clamp."),
    ("perception.merge.max_m", "Merge pass", "radius max (m)", float, 0.5, 8, 0.1, "Merge radius upper clamp."),
    ("perception.merge.number_m", "Merge pass", "same number (m)", float, 0, 10, 0.5, "Two buoys with the same marker number merge within this."),
    ("perception.merge.lamp_m", "Merge pass", "same lamp (m)", float, 0, 10, 0.5, "Two buoys with the same decided lamp (colour + pattern) merge within this."),
    ("perception.triangulate", "Rays (bearing only)", "triangulate", bool, 0, 1, 1, "Two rays of the same colour crossing at an angle make a buoy (far buoys become points as the boat moves). Off on the boat (decided 5 Nov)."),
    ("perception.ray_ttl_s", "Rays (bearing only)", "ray kept (s)", float, 1, 120, 1, "A bearing-only sighting is kept this long."),
    ("map.tri_min_angle_deg", "Rays (bearing only)", "min crossing (deg)", float, 1, 60, 1, "Triangulation: the rays must cross by at least this."),
    ("map.tri_max_range_m", "Rays (bearing only)", "max range (m)", float, 5, 120, 5, "Triangulation: the point no further than this from either boat position."),
    ("map.vote_full_m", "Colour votes", "full vote within (m)", float, 1, 40, 1, "A colour seen this close counts one full vote ..."),
    ("map.vote_far_m", "Colour votes", "weak vote at (m)", float, 2, 60, 1, "... falling linearly to the weak weight at this range (far frames miscolour)."),
    ("map.vote_far_w", "Colour votes", "weak weight", float, 0, 1, 0.05, "The vote weight at the far range."),
    ("perception.lamps.enabled", "Lamps", "lamp tracker", bool, 0, 1, 1, "The lamp blink decision by world bearing (v0.1.94)."),
    ("perception.lamps.az_tol_deg", "Lamps", "bearing tol (deg)", float, 0.5, 15, 0.5, "Lamp sightings within this bearing are one lamp track."),
    ("perception.lamps.window_s", "Lamps", "window (s)", float, 2, 30, 1, "The lamp track's memory."),
    ("perception.lamps.min_samples", "Lamps", "min samples", int, 2, 30, 1, "Samples in the window before a steady / flashing decision."),
    ("perception.depth_fuse_tol_deg", "Guard depth", "depth fuse tol (deg)", float, 0, 5, 0.1, "A depthless buoy inside a guard depth cluster's bearing span takes the cluster's range (needs 'use the guard's depth'). 0 = off."),
]


def _load_mods():
    if _mods:
        return _mods
    if MS not in sys.path:
        sys.path.insert(0, MS)
    try:
        import optiprimex  # noqa: F401
    except ImportError:
        raise RuntimeError(f"the mapping lab needs the team's code (OPTIPRIME-SIT/USV-master-scripts) - not found at {MS}; "
                           "set MASTER_SCRIPTS=/path/to/MASTER_SCRIPTS and restart") from None
    from optiprimex.companion import config as C
    from optiprimex.companion.frames import ControlOrigin
    from optiprimex.companion.state import LocalPose, Observation, ObsItem
    from optiprimex.usv.perception_map import PerceptionMap
    spec = importlib.util.spec_from_file_location("logview_cv_publish", os.path.join(MS, "cv/publish/cv_publish.py"))
    cvp = importlib.util.module_from_spec(spec); spec.loader.exec_module(cvp)
    pub = object.__new__(cvp.Publisher); pub.a = types.SimpleNamespace(colour="unknown")
    _mods.update(C=C, ControlOrigin=ControlOrigin, LocalPose=LocalPose, Observation=Observation, ObsItem=ObsItem, PerceptionMap=PerceptionMap, pub=pub)
    try:
        from optiprimex.usv.guard import GuardSupervisor
        _mods["Guard"] = GuardSupervisor
    except Exception:
        _mods["Guard"] = None
    return _mods


def _profile_data():
    import yaml
    return yaml.safe_load(open(PROFILE)) or {}


def _get(d, path):
    for k in path.split("."):
        if not isinstance(d, dict) or k not in d:
            return None
        d = d[k]
    return d


def _set(d, path, v):
    ks = path.split(".")
    for k in ks[:-1]:
        d = d.setdefault(k, {})
    d[ks[-1]] = v


def knobs():
    """The knob table with the deployed value (the course profile, else the code default)."""
    m = _load_mods(); data = _profile_data()
    base = m["C"].from_dict(copy.deepcopy(data))
    out = []
    for key, grp, label, typ, lo, hi, step, tip in KNOBS:
        v = _get(data, key)
        if v is None and key.startswith(("map.", "perception.")) and "." not in key.split(".", 1)[1]:
            v = getattr(base.map, key.split(".", 1)[1], None)
        if v is None:
            v = {"perception.merge.enabled": False, "perception.lamps.enabled": True, "perception.ranged_max_m": 0.0,
                 "perception.depth_fuse_tol_deg": 0.0}.get(key, None)
        out.append({"key": key, "group": grp, "label": label, "type": typ.__name__, "min": lo, "max": hi, "step": step, "tip": tip, "deployed": v})
    return {"profile": os.path.relpath(PROFILE, MS), "knobs": out}


def _cfg(overrides):
    m = _load_mods(); data = copy.deepcopy(_profile_data())
    types_ = {k[0]: k[3] for k in KNOBS}
    for k, v in (overrides or {}).items():
        if k in types_ and v is not None and v != "":
            _set(data, k, types_[k](v) if types_[k] is not bool else bool(v))
    return m["C"].from_dict(data)


def _frames(run_dir):
    recs = []
    for f in sorted(glob.glob(os.path.join(run_dir, "camera", "*", "frames.jsonl"))):
        for line in open(f, errors="ignore"):
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("ts_ns"):
                recs.append(r)
    recs.sort(key=lambda r: r["ts_ns"])
    return recs


def _guard_msgs(run_dir):
    out = {}
    for db in glob.glob(os.path.join(run_dir, "motion", "*", "boat_*.sqlite")):
        try:
            for (pl,) in sqlite3.connect(f"file:{db}?mode=ro", uri=True).execute("select payload from messages where topic='local/usv/perception/guard'"):
                b = json.loads(pl).get("body") or {}
                out[round(float(b.get("t_cam") or 0), 1)] = b
        except Exception:
            pass
    return out


def replay(run_dir, co, overrides=None, use_guard=False, every_s=1.0):
    """-> {snaps: [{t, ent: [[id, kind, colour, n, e, state, source, light, n_obs, sigma]]}], series, stats}; state 'young' = below min_obs."""
    m = _load_mods()
    with _lock:
        cfg = _cfg(overrides)
        clock = [0.0]
        pm = m["PerceptionMap"](cfg, clock=lambda: clock[0])
        origin = m["ControlOrigin"](co[0], co[1])
        recs = _frames(run_dir)
        gmsg = _guard_msgs(run_dir) if use_guard else {}
        gs = m["Guard"]((cfg.extra or {}).get("zed_guard")) if (use_guard and m["Guard"]) else None
        snaps, series, next_t, n_items = [], [], None, 0
        t0w = time.time()
        for r in recs:
            t = r["ts_ns"] / 1e9
            tel = r.get("tel") or {}
            lat, lon, hdg = tel.get("lat", r.get("lat")), tel.get("lon", r.get("lon")), r.get("heading_deg")
            if lat is None or hdg is None:
                continue
            clock[0] = t
            x, y = origin.to_local(lat, lon)
            pose = m["LocalPose"](x_n=x, y_e=y, hdg_deg=float(hdg), co_lat=origin.lat, co_lon=origin.lon, t=t)
            items = [it for i, b in enumerate(r.get("buoys") or [])
                     for it in m["pub"].frame_to_items(dict(b, status=r.get("status")), r.get("frame"), b.get("colour"), b.get("index", i))]
            n_items += len(items)
            pm.ingest(m["Observation"](t_cam=t, items=[m["ObsItem"].from_body(it) for it in items]), pose, now=t)
            g = gmsg.get(round(t, 1))
            if gs is not None and g is not None:
                gs.map_far(g, pose, pm, t)           # its own rate limit (far_t), as on the boat
            if hasattr(pm, "age_out"):
                pm.age_out(t)
            if next_t is None or t >= next_t:
                next_t = t + every_s
                snaps.append({"t": round(t, 2), "ent": _ents(pm, cfg)})
                vis = [e for e in pm.entities("buoy")]
                series.append([round(t, 2), len(vis), len([e for e in pm.ents.values() if e.kind == "buoy" and e.n_obs < cfg.map.min_obs])])
        final = [e for e in pm.entities("buoy", include_stale=True)]
        by = {}
        for e in final:
            by[e.colour] = by.get(e.colour, 0) + 1
        stats = {"frames": len(recs), "items": n_items, "buoys_final": len(final), "buoys_tracked_final": len(pm.entities("buoy")),
                 "by_colour": by, "max_visible": max([s[1] for s in series] or [0]), "rays": len(pm.rays), "triangulated": pm.n_triangulated,
                 "merged": len(getattr(pm, "merged", {}) or {}), "young_final": len([e for e in pm.ents.values() if e.kind == "buoy" and e.n_obs < cfg.map.min_obs]),
                 "obstacles": len([e for e in pm.ents.values() if e.kind == "obstacle"]), "guard_msgs": len(gmsg), "seconds": round(time.time() - t0w, 2)}
        return {"snaps": snaps, "series": series, "stats": stats}


def _ents(pm, cfg):
    out = []
    for e in pm.ents.values():
        if e.kind not in ("buoy", "obstacle"):
            continue
        st = e.state if e.n_obs >= cfg.map.min_obs else "young"
        out.append([e.id, e.kind, e.colour, round(e.x_n, 2), round(e.y_e, 2), st, e.source, e.light, e.n_obs, round(e.sigma_m, 2)])
    return out


# ---------------------------------------------------------------- presets
def _safe(name):
    n = re.sub(r"[^A-Za-z0-9 _.-]+", "", name or "").strip()[:60]
    if not n:
        raise ValueError("preset name")
    return n


def presets():
    os.makedirs(PRESETS, exist_ok=True)
    out = [{"name": "deployed (course profile)", "builtin": True, "overrides": {}, "use_guard": True,
            "note": "the knobs as in profiles/course/usv_course.yaml today (v0.1.94, the 14 Nov runs)"},
           {"name": "as on 13 Nov (v0.1.93)", "builtin": True, "use_guard": True,
            "overrides": {"perception.ranged_max_m": 0.0, "perception.merge.enabled": False, "perception.lamps.enabled": False,
                          "perception.depth_fuse_tol_deg": 0.0},
            "note": "before v0.1.94: no far-depth limit, no merge pass, no lamp tracker, no depth fusion (the boats on 13 Nov ran 0.1.93.x)"}]
    for f in sorted(glob.glob(os.path.join(PRESETS, "*.json"))):
        try:
            out.append({**json.load(open(f)), "builtin": False})
        except Exception:
            pass
    return out


def save_preset(p):
    name = _safe(p.get("name"))
    if name.startswith(("deployed", "as on 13 Nov")):
        raise ValueError("that name is the built-in preset")
    os.makedirs(PRESETS, exist_ok=True)
    keep = {k: p.get(k) for k in ("overrides", "use_guard", "note", "truth")}
    json.dump({"name": name, "saved": time.strftime("%Y-%m-%d %H:%M"), **keep}, open(os.path.join(PRESETS, name + ".json"), "w"), indent=1)
    return name


def delete_preset(name):
    f = os.path.join(PRESETS, _safe(name) + ".json")
    if os.path.exists(f):
        os.remove(f)
