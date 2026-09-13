// privacy/engine/fuse.ts
// DOM + vision detection fusion — ML-4 rules, browser runtime port (M6-D).
//
// Faithful TypeScript port of the validated Python reference
// ml/fusion/fuse.py (fuse_detections), which owns the fusion semantics:
// DO NOT change the rules here without changing the Python module first and
// re-running its tests. Ported rules (identical):
//
// - Coordinates: vision bboxes are SCREENSHOT pixels; DOM bboxes are CSS
//   viewport pixels. Vision boxes are scaled BEFORE matching:
//       sx = viewport.w / screenshot.w ; sy = viewport.h / screenshot.h
//       css_bbox = [round(x*sx), round(y*sy), round(w*sx), round(h*sy)]
// - Matching: IoU >= 0.3; highest IoU wins; ties break to the element
//   EARLIER in the elements list (strict > only replaces).
// - Merge: keyed by (element_id, category). DOM detections first; a matched
//   vision detection replaces an existing entry only on STRICTLY higher
//   confidence (tie -> DOM wins, the deterministic signal). One detection
//   per (element, category).
// - Matched vision detections receive the DOM element's element_id and keep
//   source:"vision".
// - Unmatched FACE: KEPT with the synthetic stable id "vision-<i>" (index in
//   the vision input list) — redactVisual() redacts by bbox+category and
//   never resolves element_id, and applyPlaceholders() safely ignores ids
//   with no backing element. FACE is inherently visual; dropping it would
//   leak face pixels.
// - Unmatched non-FACE vision detections: SKIPPED (documented M4
//   limitation — the structural placeholder machinery works on real DOM ids).
// - DOM-only PASSWORD detections always survive the merge.
// - Only element_id and bbox of elements are read; text/label values are
//   never accessed, copied, or emitted (no text/label leakage).
//
// Privacy: pure local computation, no I/O, no network, no persistence.

import type { Detection, ElementMeta, Viewport } from "../../types/index.js";

/** Minimum IoU for a vision detection to match a DOM element (M4 rule). */
export const IOU_THRESHOLD = 0.3;

/** IoU of two [x, y, w, h] boxes. Mirrors ml/fusion/fuse.py:iou and the
 * offline detector's implementation. */
export function iou(a: readonly number[], b: readonly number[]): number {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = aw * ah + bw * bh - inter;
  return union > 0 ? inter / union : 0;
}

/** Python round(): round-half-to-even (JS Math.round is half-up). */
function roundHalfEven(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** Scale a screenshot-pixel bbox into viewport/CSS pixels (fuse.py:scale_bbox). */
function scaleBBox(bbox: readonly number[], sx: number, sy: number): [number, number, number, number] {
  const [x, y, w, h] = bbox;
  return [roundHalfEven(x * sx), roundHalfEven(y * sy), roundHalfEven(w * sx), roundHalfEven(h * sy)];
}

/**
 * Fuse DOM and vision detections into one Detection[] list (ML-4 rules).
 * Inputs are never mutated; no element text is read or emitted.
 *
 * @param elements ElementMeta[] from the Capture Layer (only element_id and
 *        bbox are read).
 * @param domDetections detectSensitive() output (source:"dom").
 * @param visionDetections Detector output (source:"vision"), bboxes in
 *        SCREENSHOT pixel space.
 * @param screenshot Screenshot pixel dimensions {w, h}.
 * @param viewport CSS viewport dimensions {w, h}.
 */
export function fuseDetections(
  elements: readonly ElementMeta[],
  domDetections: readonly Detection[],
  visionDetections: readonly Detection[],
  screenshot: { w: number; h: number },
  viewport: Viewport
): Detection[] {
  const { w: sw, h: sh } = screenshot;
  const { w: vw, h: vh } = viewport;
  if (sw <= 0 || sh <= 0 || vw <= 0 || vh <= 0) {
    throw new Error(
      `fuseDetections: screenshot and viewport dimensions must be positive (screenshot=${sw}x${sh}, viewport=${vw}x${vh})`
    );
  }
  const sx = vw / sw;
  const sy = vh / sh;

  // Keyed merge: one detection per (element_id, category).
  // DOM first (input order), so ties prefer the deterministic DOM signal.
  // Map preserves insertion order (Python dict semantics): a replaced entry
  // keeps its original position.
  const key = (id: string, category: string) => `${id}\u0000${category}`;
  const merged = new Map<string, Detection>();
  for (const det of domDetections) {
    merged.set(key(det.element_id, det.category), { ...det });
  }

  visionDetections.forEach((det, i) => {
    const cssBBox = scaleBBox(det.bbox, sx, sy);

    // Best-IoU element; ties -> earlier element wins (strict > only replaces).
    let bestId: string | null = null;
    let bestIou = 0;
    for (const el of elements) {
      const score = iou(cssBBox, el.bbox);
      if (score > bestIou) {
        bestId = el.element_id;
        bestIou = score;
      }
    }

    if (bestId !== null && bestIou >= IOU_THRESHOLD) {
      const k = key(bestId, det.category);
      const candidate: Detection = {
        element_id: bestId,
        category: det.category,
        bbox: cssBBox,
        confidence: det.confidence,
        source: "vision",
      };
      const existing = merged.get(k);
      if (existing === undefined || candidate.confidence > existing.confidence) {
        merged.set(k, candidate);
      }
      // else: duplicate — keep the existing (DOM-preferred) detection
    } else if (det.category === "FACE") {
      // Unmatched FACE: keep with a synthetic stable id (see module header).
      const id = `vision-${i}`;
      merged.set(key(id, "FACE"), {
        element_id: id,
        category: "FACE",
        bbox: cssBBox,
        confidence: det.confidence,
        source: "vision",
      });
    }
    // else: unmatched non-FACE vision detection — skipped by design.
  });

  return [...merged.values()];
}
