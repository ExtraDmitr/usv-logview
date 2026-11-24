"""The lamp colour reader (13 Nov lantern test): on each box of a base engine, the lamp band above the hull (led_core.led_band, v0.1.93.2:
from 45 % of the box height above its top to 20 % into it) -> hue / saturation histogram of the bright pixels -> the learned softmax
(lamp_model.json: none / red / green / blue). A colour is called only above the threshold (0.7 by default)."""
import importlib.util, json, os, sys
import numpy as np
from engines import Engine

CSS = {"red": "#ff4040", "green": "#30d158", "blue": "#3b82ff", "none": "#888888"}


def feats(px):
    """As lamp_model.py: 18 hue bins x 4 saturation layers of the bright (V >= 150) pixels, as shares of the band, + 3 shares."""
    n = max(1, len(px)); h, sat, v = px[:, 0], px[:, 1], px[:, 2]
    br = v >= 150
    f = []
    for lo, hi in ((40, 80), (80, 120), (120, 170), (170, 256)):
        m = br & (sat >= lo) & (sat < hi)
        f += list(np.histogram(h[m], bins=18, range=(0, 180))[0] / n)
    f += [br.mean(), (br & (sat >= 80)).mean(), (v >= 230).mean()]
    return np.array(f, float)


class Lamp(Engine):
    name = "lamp"
    label = "Lamp colour reader"
    kind = "attribute"
    description = "Reads the lantern colour above each box of the chosen base engine with the 13 Nov learned lamp model."
    colour = "#ffffff"

    def available(self):
        miss = [p for p in (self.cfg.get("model", ""), self.cfg.get("led_core", "")) if not os.path.exists(p)]
        return (not miss, "" if not miss else "missing: " + ", ".join(miss))

    def load(self):
        m = json.load(open(self.cfg["model"]))
        self.mu, self.sd, self.W, self.b, self.cl = (np.array(m["mu"]), np.array(m["sd"]), np.array(m["W"]), np.array(m["b"]), m["classes"])
        s = importlib.util.spec_from_file_location("logview_led_core", self.cfg["led_core"])
        self.lc = importlib.util.module_from_spec(s); sys.modules["logview_led_core"] = self.lc; s.loader.exec_module(self.lc)

    def detect(self, image_bgr, ctx):
        import cv2
        H, W = image_bgr.shape[:2]
        thr = float(self.cfg.get("threshold", 0.7))
        out = []
        for bx in ctx.get("boxes") or []:
            x1, y1, x2, y2 = self.lc.led_band(bx["bbox"])
            x1, y1, x2, y2 = max(0, x1), max(0, y1), min(W, x2), min(H, y2)
            if x2 - x1 < 2 or y2 - y1 < 2:
                continue
            px = cv2.cvtColor(image_bgr[y1:y2, x1:x2], cv2.COLOR_BGR2HSV).reshape(-1, 3).astype(int)
            z = (feats(px) - self.mu) / self.sd
            p = np.exp(z @ self.W + self.b); p /= p.sum()
            k = int(p.argmax())
            if k > 0 and p[k] < thr:
                k = 0
            c = self.cl[k]
            out.append({"bbox": [x1, y1, x2, y2], "cls": f"lamp {c}", "conf": float(p[k]), "colour": CSS.get(c, "#fff"),
                        "label": f"lamp {c} {p[k]:.2f}" if c != "none" else "lamp off",
                        "extra": {"probs": {cl: round(float(v), 3) for cl, v in zip(self.cl, p)}, "threshold": thr, "of_box": bx.get("label")}})
        return out


ENGINE = Lamp()
