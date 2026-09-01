# Local Privacy Vision Engine

Architecture box 2 of 6. Name is locked: **Local Privacy Vision Engine**.

## Responsibility

Fuse DOM-rule detections with (later) visual model detections into one detections list. Each detection:

```json
{ "element_id": "f3", "category": "PAN", "bbox": [x, y, w, h], "confidence": 0.92, "source": "dom" | "vision" }
```

Overlapping boxes from both sources are merged (union), keeping the highest confidence. Output goes to the Sanitizer only.

## Categories

`FACE`, `PAN`, `AADHAAR`, `EMAIL`, `PHONE`, `AMOUNT`, `PASSWORD`, `NAME`

## DOM path (now)

The deterministic engine is implemented in `privacy/sanitizer/structural-redact.ts` (`detectSensitive` and `detectVisibleTextPii`). It handles PAN / Aadhaar / email / phone / amount patterns, Luhn-validated card-like values, sensitive autocomplete/input fields, and visible text nodes with viewport-relative `Range` boxes. The vision adapter contract lives in `vision-detector.ts`; real model adapters can be added without changing the capture or privacy contracts.

## Vision path (later)

ONNX Runtime Web / Transformers.js / WebGPU inference running **inside the extension** — not a local Python process. Face detection and text-region detection models, exported from Python training (out of scope for this repo). Latency vs accuracy trade-off is the PS requirement; no accuracy claims are made in this repo.

## Inputs

Capture package from the Capture Layer:

- Screenshot (in memory only — never written to disk)
- Elements + bounding boxes + labels
- Browser state

## Outputs

Detections list for the Sanitizer (shape above).

## Forbidden

- Training scripts, `.py` files, `.onnx` model files in this repo.
- Raw screenshot upload.
- Inventing new box names — the engine is one box; the Sanitizer, Policy Gate, etc. are separate.
