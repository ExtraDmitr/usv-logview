"""CV engine plug-ins. Every engines/<name>.py defines ENGINE = <an Engine subclass instance>; it is picked up at start.

An engine is either
- a "detector": detect(image_bgr, ctx) -> boxes, from the frame alone (or from the recorded log, see recorded.py), or
- an "attribute" engine: it runs on the boxes of another engine (ctx["boxes"]) and adds fields (e.g. the lamp colour).
A box is a dict: {"bbox": [x1, y1, x2, y2] in full-resolution left-image pixels, "cls": str, "conf": float, "colour": css colour or None,
"label": short text drawn on the box, "extra": {anything shown in the box's pop-up}}.
ctx: {"frame": the frames.jsonl record of this frame or None, "boxes": the base engine's boxes (attribute engines), "session": session
dir, "frame_index": svo frame number}.
Paths and options come from engines.json (the "engines" block, keyed by the engine's name), so models can be swapped without code."""
import importlib, json, os, pkgutil, traceback

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(os.path.dirname(HERE), "engines.json")


class Engine:
    name = "base"
    label = "base"
    kind = "detector"            # or "attribute"
    description = ""
    colour = "#ffcc00"

    def __init__(self):
        self.cfg = {}
        self._loaded = False

    def configure(self, cfg):
        self.cfg = cfg or {}

    def available(self):
        """(ok, reason) without loading heavy models."""
        return True, ""

    def load(self):
        """Load models once, on first use."""

    def detect(self, image_bgr, ctx):
        raise NotImplementedError

    def run(self, image_bgr, ctx):
        if not self._loaded:
            self.load(); self._loaded = True
        return self.detect(image_bgr, ctx)


def discover():
    cfg = json.load(open(CONFIG)).get("engines", {}) if os.path.exists(CONFIG) else {}
    out = {}
    for m in pkgutil.iter_modules([HERE]):
        try:
            mod = importlib.import_module(f"engines.{m.name}")
            e = getattr(mod, "ENGINE", None)
            if isinstance(e, Engine):
                if cfg.get(e.name, {}).get("enabled", True) is False:
                    continue
                c = {k: (os.path.expanduser(os.path.expandvars(v)) if isinstance(v, str) else v) for k, v in (cfg.get(e.name) or {}).items()}
                e.configure(c)
                out[e.name] = e
        except Exception:
            print(f"engine {m.name} not loaded:\n{traceback.format_exc()}")
    return out
