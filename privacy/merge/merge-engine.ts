import type { BoundingBox, Detection } from "../../types/index.js";

export interface MergeOptions { minConfidence?: number; iouThreshold?: number; }

function validBox(bbox: BoundingBox): boolean {
  return bbox.length === 4 && bbox.every(Number.isFinite) && bbox[2] > 0 && bbox[3] > 0;
}

function iou(a: BoundingBox, b: BoundingBox): number {
  const left = Math.max(a[0], b[0]);
  const top = Math.max(a[1], b[1]);
  const right = Math.min(a[0] + a[2], b[0] + b[2]);
  const bottom = Math.min(a[1] + a[3], b[1] + b[3]);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a[2] * a[3] + b[2] * b[3] - intersection;
  return union > 0 ? intersection / union : 0;
}

function unionBox(a: BoundingBox, b: BoundingBox): BoundingBox {
  const left = Math.min(a[0], b[0]);
  const top = Math.min(a[1], b[1]);
  const right = Math.max(a[0] + a[2], b[0] + b[2]);
  const bottom = Math.max(a[1] + a[3], b[1] + b[3]);
  return [left, top, right - left, bottom - top];
}

/** Same-category IoU merge. Different privacy semantics never merge. */
export class MergeEngine {
  constructor(private readonly options: MergeOptions = {}) {}

  merge(...groups: Detection[][]): Detection[] {
    const minimum = this.options.minConfidence ?? 0.5;
    const threshold = this.options.iouThreshold ?? 0.5;
    const result: Detection[] = [];
    for (const detection of groups.flat()) {
      if (!validBox(detection.bbox) || !Number.isFinite(detection.confidence) || detection.confidence < minimum) continue;
      const existing = result.find((candidate) => candidate.category === detection.category && iou(candidate.bbox, detection.bbox) >= threshold);
      if (!existing) {
        result.push({ ...detection, metadata: detection.metadata ? { ...detection.metadata } : undefined });
        continue;
      }
      existing.bbox = unionBox(existing.bbox, detection.bbox);
      existing.confidence = Math.max(existing.confidence, detection.confidence);
      existing.metadata = { ...existing.metadata, ...detection.metadata, mergedSources: [existing.source, detection.source] };
    }
    return result.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0] || a.category.localeCompare(b.category));
  }
}

export { iou };
