"""Depth for one frame, in the geometry of the left image the viewer shows: the ZED SDK's rectified left (core.py: left.mp4). Two sources:
- "recorded": the AGX's neural depth saved beside some frames (camera/<s>/pairs/depth_NNNNNN.png, uint16 mm; pairs.jsonl maps svo_frame ->
  file). The SDK produced it in exactly that geometry: no warp, only the browser scales it.
- "stereo": computed on the Mac for any frame from the RAW eyes (left_raw / right_raw), rectified with calib/SN<serial>.conf, OpenCV SGBM at
  half resolution with a left-right check, low-texture pixels (water, sky) masked out, a median filter; then mapped into the SDK left
  geometry with one homography (SDK pixel -> undistorted ray -> our rectified pixel). Coarser than the neural depth; water mostly empty.
Both return (depth_m float32 HxW with 0 = no depth, info dict)."""
import configparser, glob, json, os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
_cache = {}
RES = {2208: "2K", 1920: "FHD", 1280: "HD", 672: "VGA"}


def recorded_index(sd):
    p = os.path.join(sd, "pairs", "pairs.jsonl")
    out = {}
    if os.path.exists(p):
        for line in open(p):
            try:
                r = json.loads(line)
                out[int(r["svo_frame"])] = os.path.join(sd, "pairs", r["depth"])
            except Exception:
                pass
    return out


def _conf(serial):
    confs = glob.glob(os.path.join(HERE, "calib", f"SN{serial}.conf")) or glob.glob(os.path.join(HERE, "calib", "*.conf"))
    if not confs:
        raise FileNotFoundError("no ZED calibration in calib/")
    c = configparser.ConfigParser(); c.read(confs[0])
    return c, os.path.basename(confs[0])


def _cam(c, side, res, scale):
    s = c[f"{side}_CAM_{res}"]
    K = np.array([[float(s["fx"]), 0, float(s["cx"])], [0, float(s["fy"]), float(s["cy"])], [0, 0, 1]])
    K[:2] *= scale
    return K, np.array([[float(s[k]) for k in ("k1", "k2", "p1", "p2", "k3")]])


def _raw_to(K, D, R, P, w, h):
    """For every RAW pixel (x, y) of a w x h image: where it lands in the rectified / undistorted image (R, P) -> remap maps that pull
    a rectified-frame array onto the raw grid."""
    import cv2
    xs, ys = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    pts = np.stack([xs.ravel(), ys.ravel()], 1).reshape(-1, 1, 2)
    u = cv2.undistortPoints(pts, K, D, R=R, P=P).reshape(h, w, 2)
    return u[..., 0].astype(np.float32), u[..., 1].astype(np.float32)


def _stereo_rig(serial, W, H, scale):
    import cv2
    key = ("rig", serial, W, H, scale)
    if key not in _cache:
        c, name = _conf(serial); res = RES.get(W, "2K")
        K1, D1 = _cam(c, "LEFT", res, scale); K2, D2 = _cam(c, "RIGHT", res, scale)
        st = c["STEREO"]
        R, _ = cv2.Rodrigues(np.array([float(st[f"RX_{res}"]), float(st[f"CV_{res}"]), float(st[f"RZ_{res}"])]))
        T = np.array([[-float(st["Baseline"])], [float(st["TY"])], [float(st["TZ"])]]) / 1000.0
        w, h = int(round(W * scale)), int(round(H * scale))
        R1, R2, P1, P2, Q, _, _ = cv2.stereoRectify(K1, D1, K2, D2, (w, h), R, T, alpha=0)
        m1 = cv2.initUndistortRectifyMap(K1, D1, R1, P1, (w, h), cv2.CV_32FC1)
        m2 = cv2.initUndistortRectifyMap(K2, D2, R2, P2, (w, h), cv2.CV_32FC1)
        _cache[key] = (m1, m2, float(P1[0, 0]), abs(float(T[0, 0])), name, res, K1, R1, P1)
    return _cache[key]


def recorded(sd, frame):
    import cv2
    f = recorded_index(sd).get(int(frame))
    if not f or not os.path.exists(f):
        return None, {"source": "recorded", "error": "no saved depth for this frame"}
    mm = cv2.imread(f, cv2.IMREAD_UNCHANGED)
    return mm.astype(np.float32) / 1000.0, {"source": "recorded (AGX neural depth, ZED SDK geometry)", "file": os.path.basename(f)}


def stereo(left_raw, right_raw, serial=None, sdk=None, scale=0.5, max_m=40.0, texture_min=6.0, mode="plane", cam_h=0.55):
    """left_raw / right_raw: the unrectified eyes. sdk: {"scale", "rot_deg", "shift_px": [dx, dy] at full resolution} (core.py index)."""
    import cv2
    H, W = left_raw.shape[:2]
    m1, m2, f, B, name, res, K1, R1, P1 = _stereo_rig(serial, W, H, scale)
    w, h = int(round(W * scale)), int(round(H * scale))
    small = lambda im: cv2.resize(im, (w, h), interpolation=cv2.INTER_AREA)
    gl = cv2.cvtColor(cv2.remap(small(left_raw), *m1, cv2.INTER_LINEAR), cv2.COLOR_BGR2GRAY)
    gr = cv2.cvtColor(cv2.remap(small(right_raw), *m2, cv2.INTER_LINEAR), cv2.COLOR_BGR2GRAY)
    nd, bs = 160, 5
    sgbm = cv2.StereoSGBM_create(minDisparity=0, numDisparities=nd, blockSize=bs, P1=8 * bs * bs, P2=32 * bs * bs, disp12MaxDiff=1,
                                 uniquenessRatio=15, speckleWindowSize=150, speckleRange=1, preFilterCap=31,
                                 mode=cv2.STEREO_SGBM_MODE_SGBM_3WAY)
    disp = sgbm.compute(gl, gr).astype(np.float32) / 16.0
    tex = cv2.blur(np.abs(cv2.Sobel(gl, cv2.CV_32F, 1, 0, ksize=3)), (9, 9))      # SGBM invents disparities on flat water / sky
    disp[tex < texture_min] = 0
    disp[:, :nd] = 0                                                               # no right-image match in the left band
    disp = cv2.medianBlur(np.where(disp > 0, disp, 0).astype(np.float32), 5)
    with np.errstate(divide="ignore"):
        z = np.where(disp > 0.5, f * B / disp, 0).astype(np.float32)
    z[z > max_m] = 0
    # our rectified frame -> the SDK left geometry: p_rect = P1 R1 K^-1 A^-1 p_sdk (all at this half resolution)
    sdk = sdk or {"scale": 1.0, "rot_deg": 0.0, "shift_px": [0.0, 0.0]}
    c_, s_ = sdk["scale"] * np.cos(np.radians(sdk["rot_deg"])), sdk["scale"] * np.sin(np.radians(sdk["rot_deg"]))
    A = np.array([[c_, -s_, sdk["shift_px"][0] * scale], [s_, c_, sdk["shift_px"][1] * scale], [0, 0, 1]])
    M = P1[:, :3] @ R1 @ np.linalg.inv(K1) @ np.linalg.inv(A)
    z = cv2.warpPerspective(z, M, (w, h), flags=cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    info = {"calib": name, "resolution": res, "baseline_m": round(B, 4), "fx_px": round(f, 1)}
    if mode == "raw":
        info["source"] = "stereo raw (OpenCV SGBM, half resolution): water reflections and ripples give patchy, partly wrong depth"
    else:
        z, wz, vh = water_split(z, K1[1, 1], cam_h)
        info["horizon_row_frac"] = round(vh / h, 4) if vh else None
        if mode == "objects":
            info["source"] = f"stereo, objects only: SGBM points standing > {OBJ_MIN_M} m above the water plane (reflections removed)"
        else:
            z = np.where(z > 0, z, wz).astype(np.float32)
            info["source"] = f"stereo objects + modelled water plane (camera {cam_h:.2f} m above the water, horizon from this frame) - the water is a model, not measured"
    info["valid_pct"] = round(100.0 * float((z > 0).mean()), 1)
    return z, info


OBJ_MIN_M = 0.15      # a stereo point this far above the water plane is an object (buoy, boat, shore)
MIN_BLOB_PX = 60      # smaller isolated object blobs (at half resolution) are noise


def water_split(z, f, cam_h, max_m=25.0):
    """z (the SDK left geometry): -> (objects-only depth, the water plane's depth, the horizon row). The horizon is found per frame: every
    stereo pixel in the lower part votes the horizon row it would imply if it lay on the water (v - cam_h f / z); the mode is the water
    (ripples are many and agree). A pixel standing more than OBJ_MIN_M above that plane is an object; below it (a reflection) or on it is
    dropped. f: the focal length in pixels at z's resolution."""
    import cv2
    hh, ww = z.shape
    v = np.repeat(np.arange(hh, dtype=np.float32)[:, None], ww, 1)
    m = (z > 0.5) & (v > hh * 0.4)
    if m.sum() < 200:
        return z, np.zeros_like(z), None
    hist, edges = np.histogram(v[m] - cam_h * f / z[m], bins=160, range=(0, hh))
    vh = float(edges[hist.argmax()] + (edges[1] - edges[0]) / 2)
    with np.errstate(divide="ignore", invalid="ignore"):
        height = cam_h - z * (v - vh) / f
    obj = np.where((z > 0) & (height > OBJ_MIN_M), z, 0).astype(np.float32)
    n, lab, st, _ = cv2.connectedComponentsWithStats((obj > 0).astype(np.uint8), 8)
    obj[np.isin(lab, np.where(st[:, cv2.CC_STAT_AREA] < MIN_BLOB_PX)[0])] = 0
    with np.errstate(divide="ignore"):
        wz = np.where(v > vh + 2, cam_h * f / np.maximum(v - vh, 1e-3), 0).astype(np.float32)
    wz[wz > max_m] = 0
    return obj, wz, vh


def fit_camera_height(sd, H_full, fy_full):
    """The camera's height above the water from the recorded neural depth (on water 1/Z = (v - v_h) / (h f), v the full-resolution row);
    None without recorded depth."""
    A, Bv = [], []
    for k in sorted(recorded_index(sd))[::2][:20]:
        z, _ = recorded(sd, k); hh, ww = z.shape; sc = H_full / hh
        for v in range(int(hh * 0.62), hh, 6):
            row = z[v, int(ww * .2):int(ww * .8)]; row = row[(row > 0.5) & (row < 20)]
            if len(row) > 50:
                A.append(v * sc); Bv.append(1.0 / float(np.median(row)))
    if len(A) < 20:
        return None
    slope, _ = np.polyfit(np.array(A), np.array(Bv), 1)
    hgt = 1.0 / (slope * fy_full)
    return round(float(hgt), 3) if 0.2 < hgt < 2.0 else None
