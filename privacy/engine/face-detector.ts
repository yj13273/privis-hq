import * as blazeface from "@tensorflow-models/blazeface";
import * as tf from "@tensorflow/tfjs";
import { imageToImageData } from "../../utils/image.js";
import { imageToViewportBBox } from "../../utils/coordinates.js";
import type { DetectorDiagnostics, VisionDetector, VisionDetectorResult, VisionFrame } from "./vision-detector.js";
import { unavailableResult } from "./vision-detector.js";

export interface FaceDetectorOptions {
  model?: blazeface.BlazeFaceModel;
  modelUrl?: string;
  scoreThreshold?: number;
  maxFaces?: number;
}

/** Real BlazeFace adapter with model reuse and TensorFlow backend diagnostics. */
export class FaceDetector implements VisionDetector {
  readonly name = "face";
  private model: blazeface.BlazeFaceModel | null;
  private readonly modelUrl?: string;
  private readonly scoreThreshold: number;
  private readonly maxFaces: number;
  private initializationError: string | undefined;
  private backend = "uninitialized";
  private nextId = 0;

  constructor(options: FaceDetectorOptions = {}) {
    this.model = options.model ?? null;
    this.modelUrl = options.modelUrl;
    this.scoreThreshold = options.scoreThreshold ?? 0.6;
    this.maxFaces = options.maxFaces ?? 10;
  }

  isAvailable(): boolean { return this.model !== null; }

  async initialize(): Promise<void> {
    if (this.model) return;
    try {
      this.backend = tf.getBackend();
      this.model = await blazeface.load({ maxFaces: this.maxFaces, scoreThreshold: this.scoreThreshold, modelUrl: this.modelUrl });
      this.backend = tf.getBackend();
    } catch (error) {
      this.model = null;
      this.initializationError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async detect(frame: VisionFrame): Promise<VisionDetectorResult> {
    if (!this.model) {
      try { await this.initialize(); } catch { return unavailableResult(this.initializationError ?? "BlazeFace unavailable"); }
    }
    const started = performance.now();
    try {
      const imageData = await imageToImageData(frame.image);
      // BlazeFace accepts native browser image sources. Keep those inputs intact
      // when possible; screenshot/data-url frames still use the normalized ImageData path.
      const modelInput = frame.image instanceof HTMLImageElement || frame.image instanceof HTMLCanvasElement
        ? frame.image
        : imageData;
      const faces = await this.model!.estimateFaces(modelInput, false, false, true);
      const detections = faces.flatMap((face) => {
        const probability = typeof face.probability === "number"
          ? face.probability
          : face.probability?.dataSync?.()[0] ?? 0;
        const topLeft = this.readPoint(face.topLeft);
        const bottomRight = this.readPoint(face.bottomRight);
        if (probability < this.scoreThreshold || !topLeft || !bottomRight) return [];
        const box = [topLeft[0], topLeft[1], bottomRight[0] - topLeft[0], bottomRight[1] - topLeft[1]] as [number, number, number, number];
        if (box[2] <= 0 || box[3] <= 0) return [];
        return [{
          element_id: `vision-face-${++this.nextId}`,
          category: "FACE",
          bbox: imageToViewportBBox(box, imageData.width, imageData.height, frame.viewport),
          confidence: Math.max(0, Math.min(1, probability)),
          source: "vision" as const,
          metadata: { detector: "blazeface", backend: this.backend },
        }];
      });
      return { detections, diagnostics: { available: true, latencyMs: performance.now() - started } };
    } catch (error) {
      return unavailableResult(error instanceof Error ? error.message : String(error));
    }
  }

  async dispose(): Promise<void> {
    this.model = null;
    this.initializationError = undefined;
  }

  private readPoint(point: [number, number] | { dataSync?: () => ArrayLike<number> } | undefined): [number, number] | null {
    const values = Array.isArray(point) ? point : point?.dataSync?.();
    if (!values || values.length < 2 || !Number.isFinite(values[0]) || !Number.isFinite(values[1])) return null;
    return [values[0], values[1]];
  }

  getDiagnostics(): DetectorDiagnostics & { backend: string } {
    return this.model ? { available: true, backend: this.backend } : { available: false, backend: this.backend, error: this.initializationError ?? "BlazeFace model not initialized" };
  }
}
