"""Our buoy detector (the weights the AGX TensorRT engine was built from), run with ultralytics on the Mac (Apple GPU when available).
Same input size and confidence as on the boat (session options imgsz 768, conf 0.6) unless engines.json says otherwise."""
import os
from engines import Engine
from engines.recorded import CSS


class YoloBuoys(Engine):
    name = "yolo_buoys"
    label = "Our buoy detector (best.pt)"
    description = "cv/buoys YOLO weights (md5 320e6a96...), ultralytics on the Mac: what the boat's detector sees on this frame."
    colour = "#00e5ff"

    def available(self):
        p = self.cfg.get("weights", "")
        return (os.path.exists(p), "" if os.path.exists(p) else f"weights not found: {p}")

    def load(self):
        from ultralytics import YOLO
        import torch
        self.model = YOLO(self.cfg["weights"], task="detect")
        self.device = self.cfg.get("device") or ("mps" if torch.backends.mps.is_available() else "cpu")

    def detect(self, image_bgr, ctx):
        r = self.model.predict(image_bgr, imgsz=int(self.cfg.get("imgsz", 768)), conf=float(self.cfg.get("conf", 0.6)), device=self.device,
                               verbose=False)[0]
        out = []
        for b in r.boxes:
            c = self.model.names[int(b.cls)]
            x1, y1, x2, y2 = (float(v) for v in b.xyxy[0])
            out.append({"bbox": [x1, y1, x2, y2], "cls": c, "conf": float(b.conf), "colour": CSS.get(c, self.colour),
                        "label": f"{c} {float(b.conf):.2f}", "extra": {"model": os.path.basename(self.cfg["weights"])}})
        return out


ENGINE = YoloBuoys()
