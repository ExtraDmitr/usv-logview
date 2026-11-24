"""The student's CV_NEW 11-12 pipeline (read-only weights in MASTER_SCRIPTS/CV_NEW/11-12), as in our 12 Nov evaluation
(_labels/cv_review/cv_new_11-12/eval_cv_new.py): buoy_detector 1280 (number_buoy | boundary) -> each number_buoy crop (+15 % pad) ->
marker_classifier 320 (0-9, C, D) + number_detector 320 (digits). The evaluation found the classifier 75 % right, the digit detector
unreliable: both are shown, the classifier as the label."""
import os
from engines import Engine

COL = {"number_buoy": "#ff7ad9", "boundary": "#ff9f0a"}


class CvNew(Engine):
    name = "cvnew"
    label = "Student CV_NEW 11-12 pipeline"
    description = "Detector 1280 + marker classifier + number detector (the student's three models), run on the Mac."
    colour = "#ff7ad9"

    def _p(self, k):
        return os.path.join(self.cfg.get("dir", ""), self.cfg.get(k, ""))

    def available(self):
        miss = [self._p(k) for k in ("detector", "classifier", "digits") if not os.path.exists(self._p(k))]
        return (not miss, "" if not miss else "missing: " + ", ".join(miss))

    def load(self):
        from ultralytics import YOLO
        import torch
        self.det = YOLO(self._p("detector"), task="detect")
        self.cls = YOLO(self._p("classifier"), task="classify")
        self.num = YOLO(self._p("digits"), task="detect")
        self.dev = self.cfg.get("device") or ("mps" if torch.backends.mps.is_available() else "cpu")

    def detect(self, image_bgr, ctx):
        rgb = image_bgr
        r = self.det.predict(rgb, imgsz=1280, conf=float(self.cfg.get("conf", 0.25)), iou=0.5, device=self.dev, verbose=False)[0]
        out = []
        for b in r.boxes:
            c = self.det.names[int(b.cls)]
            x1, y1, x2, y2 = (float(v) for v in b.xyxy[0])
            ex, lab = {}, f"{c} {float(b.conf):.2f}"
            if c == "number_buoy":
                pad = 0.15 * max(x2 - x1, y2 - y1)
                crop = rgb[max(0, int(y1 - pad)):int(y2 + pad), max(0, int(x1 - pad)):int(x2 + pad)]
                if crop.size:
                    cr = self.cls.predict(crop, imgsz=320, device=self.dev, verbose=False)[0]
                    ex["marker"], ex["marker_p"] = self.cls.names[int(cr.probs.top1)], round(float(cr.probs.top1conf), 3)
                    nr = self.num.predict(crop, imgsz=320, conf=0.25, device=self.dev, verbose=False)[0]
                    ex["digits"] = "".join(self.num.names[int(d.cls)] for d in sorted(nr.boxes, key=lambda d: float(d.xyxy[0][0])))
                    lab = f"#{ex['marker']} ({ex['marker_p']:.2f})"
            out.append({"bbox": [x1, y1, x2, y2], "cls": c, "conf": float(b.conf), "colour": COL.get(c, self.colour), "label": lab, "extra": ex})
        return out


ENGINE = CvNew()
