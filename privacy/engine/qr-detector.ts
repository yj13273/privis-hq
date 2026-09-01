import jsQR from "jsqr";
import type { BoundingBox } from "../../types/index.js";
import { imageToViewportBBox } from "../../utils/coordinates.js";
import { imageToImageData } from "../../utils/image.js";
import type { DetectorDiagnostics, VisionDetector, VisionDetectorResult, VisionFrame } from "./vision-detector.js";
import { unavailableResult } from "./vision-detector.js";

/** Real QR-only adapter. jsQR does not decode arbitrary linear barcodes. */
export class QrDetector implements VisionDetector {
  readonly name = "qr";
  private initialized = false;
  private initializationError: string | undefined;
  private nextId = 0;

  isAvailable(): boolean { return this.initialized; }

  async initialize(): Promise<void> {
    this.initialized = true;
    this.initializationError = undefined;
  }

  async detect(frame: VisionFrame): Promise<VisionDetectorResult> {
    if (!this.initialized) await this.initialize();
    const started = performance.now();
    try {
      const imageData = await imageToImageData(frame.image);
      const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: "attemptBoth" });
      if (!code?.location) return { detections: [], diagnostics: { available: true, latencyMs: performance.now() - started } };
      const points = [code.location.topLeftCorner, code.location.topRightCorner, code.location.bottomRightCorner, code.location.bottomLeftCorner];
      const imageBox: BoundingBox = [
        Math.min(...points.map((point) => point.x)),
        Math.min(...points.map((point) => point.y)),
        Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x)),
        Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y)),
      ];
      const bbox = imageToViewportBBox(imageBox, imageData.width, imageData.height, frame.viewport);
      return {
        detections: [{
          element_id: `vision-qr-${++this.nextId}`,
          category: "QR",
          bbox,
          // jsQR has no calibrated confidence output; this is a deterministic decode-success score.
          confidence: 1,
          source: "vision",
          metadata: { detector: "jsqr" },
        }],
        diagnostics: { available: true, latencyMs: performance.now() - started },
      };
    } catch (error) {
      this.initializationError = error instanceof Error ? error.message : String(error);
      return unavailableResult(this.initializationError);
    }
  }

  async dispose(): Promise<void> { this.initialized = false; }

  getDiagnostics(): DetectorDiagnostics {
    return this.initialized ? { available: true } : { available: false, error: this.initializationError ?? "jsQR unavailable" };
  }
}

export const barcodeDiagnostics = {
  available: false,
  error: "No linear barcode decoder is installed; jsQR supports QR codes only",
};
