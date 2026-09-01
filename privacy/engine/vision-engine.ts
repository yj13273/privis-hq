import type { DetectorDiagnostics, VisionDetector, VisionDetectorResult, VisionFrame, VisionDetection } from "./vision-detector.js";
import { detectOcrPii } from "../sanitizer/structural-redact.js";

export interface VisionRunResult {
  detections: VisionDetection[];
  diagnostics: Record<string, DetectorDiagnostics>;
  totalLatencyMs: number;
}

/** Runs independently injected local detectors; one failure cannot stop the others. */
export class VisionEngine {
  constructor(private readonly detectors: VisionDetector[] = []) {}

  async initialize(): Promise<void> {
    await Promise.allSettled(this.detectors.map((detector) => detector.initialize()));
  }

  async run(frame: VisionFrame, context?: unknown): Promise<VisionRunResult> {
    const started = performance.now();
    const settled = await Promise.allSettled(this.detectors.map((detector) => detector.detect(frame, context)));
    const detections: VisionDetection[] = [];
    const diagnostics: Record<string, DetectorDiagnostics> = {};
    settled.forEach((result, index) => {
      const detector = this.detectors[index];
      if (result.status === "fulfilled") {
        const value: VisionDetectorResult = result.value;
        detections.push(...value.detections, ...detectOcrPii(value.detections));
        diagnostics[detector.name] = value.diagnostics;
      } else {
        diagnostics[detector.name] = {
          available: detector.isAvailable(),
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        };
      }
    });
    return { detections, diagnostics, totalLatencyMs: performance.now() - started };
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.detectors.map((detector) => detector.dispose()));
  }
}
