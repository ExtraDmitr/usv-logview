"""The boxes the AGX observer logged during the run (frames.jsonl): no model, exactly what the boat saw."""
from engines import Engine

CSS = {"red": "#ff4040", "green": "#30d158", "blue": "#3b82ff", "white": "#f5f5f5", "black": "#9aa0a6", "yellow": "#ffd60a",
       "orange": "#ff9f0a", "unknown": "#c084fc"}


class Recorded(Engine):
    name = "recorded"
    label = "Recorded (AGX observer)"
    description = "The detections logged on the boat during the run (frames.jsonl): colour, confidence, range, bearing and the lamp state."
    colour = "#ffcc00"

    def detect(self, image_bgr, ctx):
        f = ctx.get("frame") or {}
        out = []
        for b in f.get("buoys") or []:
            bb = b.get("bbox")
            if not bb:
                continue
            led = b.get("led") or {}
            rng = b.get("range_m")
            lab = f"{b.get('colour', '?')} {b.get('confidence', 0):.2f}" + (f" {rng:.1f}m" if rng else "")
            if led.get("colour"):
                lab += f" lamp:{led['colour']}"
            out.append({"bbox": bb, "cls": b.get("colour") or "buoy", "conf": b.get("confidence"), "colour": CSS.get(b.get("colour"), "#ffcc00"),
                        "label": lab,
                        "extra": {"range_m": rng, "surface_range_m": b.get("surface_range_m"), "bearing_deg": b.get("bearing_deg"),
                                  "elev_deg": b.get("elev_deg"), "bearing_only": b.get("bearing_only"), "reason": b.get("reason"),
                                  "forward_m": b.get("forward_m"), "right_m": b.get("right_m"), "lamp_colour": led.get("colour"),
                                  "lamp_pattern": led.get("pattern"), "lamp_track": led.get("track"), "lamp_samples": led.get("n"),
                                  "frame_status": f.get("status")}})
        return out


ENGINE = Recorded()
