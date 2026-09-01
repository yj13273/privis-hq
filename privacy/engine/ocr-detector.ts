import Tesseract from "tesseract.js";
import type { BoundingBox, Viewport } from "../../types/index.js";
import { imageToViewportBBox } from "../../utils/coordinates.js";
import type { DetectorDiagnostics, VisionDetector, VisionDetectorResult, VisionFrame } from "./vision-detector.js";
import { unavailableResult } from "./vision-detector.js";

export type TesseractWorker = Tesseract.Worker;
export type TesseractWorkerFactory = (
  languages: string,
  options?: Partial<Tesseract.WorkerOptions>,
) => Promise<TesseractWorker>;

export interface OcrDetectorOptions {
  language?: string;
  workerOptions?: Partial<Tesseract.WorkerOptions>;
  workerFactory?: TesseractWorkerFactory;
  minConfidence?: number;
  recognizeTimeoutMs?: number;
}

/** Real Tesseract.js OCR adapter. The worker is initialized once and reused. */
export class TesseractOcrDetector implements VisionDetector {
  readonly name = "ocr";
  private worker: TesseractWorker | null = null;
  private initializationError: string | undefined;
  private initializationLatencyMs = 0;
  private readonly language: string;
  private readonly workerOptions: Partial<Tesseract.WorkerOptions>;
  private readonly workerFactory: TesseractWorkerFactory;
  private readonly minConfidence: number;
  private readonly recognizeTimeoutMs: number;
  private nextId = 0;

  constructor(options: OcrDetectorOptions = {}) {
    this.language = options.language ?? "eng";
    this.workerOptions = options.workerOptions ?? {};
    this.workerFactory = options.workerFactory ?? ((language, workerOptions) =>
      Tesseract.createWorker(language, Tesseract.OEM.LSTM_ONLY, workerOptions));
    this.minConfidence = options.minConfidence ?? 0;
    this.recognizeTimeoutMs = options.recognizeTimeoutMs ?? 60000;
  }

  isAvailable(): boolean {
    return this.worker !== null;
  }

  async initialize(): Promise<void> {
    if (this.worker) return;
    const started = performance.now();
    try {
      this.worker = await this.workerFactory(this.language, this.workerOptions);
      this.initializationLatencyMs = performance.now() - started;
      this.initializationError = undefined;
    } catch (error) {
      this.worker = null;
      this.initializationLatencyMs = performance.now() - started;
      this.initializationError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async detect(frame: VisionFrame): Promise<VisionDetectorResult> {
    if (!this.worker) {
      try {
        await this.initialize();
      } catch {
        return unavailableResult(this.initializationError ?? "Tesseract worker unavailable");
      }
    }
    const started = performance.now();
    try {
      const recognition = this.worker!.recognize(frame.image as Tesseract.ImageLike);
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Tesseract recognition timed out")), this.recognizeTimeoutMs);
      });
      let result: Tesseract.RecognizeResult;
      try {
        result = await Promise.race([recognition, timeout]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
      const detections = (result.data.words ?? []).flatMap((word) => {
        const text = word.text?.trim() ?? "";
        const confidence = Math.max(0, Math.min(1, (word.confidence ?? 0) / 100));
        const bbox = this.toViewportBBox(word.bbox, frame.width, frame.height, frame.viewport);
        if (!text || confidence < this.minConfidence || !bbox) return [];
        return [{
          element_id: `ocr-${++this.nextId}`,
          bbox,
          category: "OCR_TEXT",
          confidence,
          source: "vision" as const,
          metadata: { text, level: "word", sourceModel: "tesseract.js" },
        }];
      });
      const diagnostics: DetectorDiagnostics = {
        available: true,
        latencyMs: performance.now() - started,
      };
      return { detections, diagnostics };
    } catch (error) {
      if (error instanceof Error && error.message === "Tesseract recognition timed out") {
        await this.dispose();
      }
      return unavailableResult(error instanceof Error ? error.message : String(error));
    }
  }

  private toViewportBBox(
    bbox: Tesseract.Bbox | undefined,
    imageWidth: number,
    imageHeight: number,
    viewport: Viewport,
  ): BoundingBox | null {
    if (!bbox) return null;
    const imageBox: BoundingBox = [bbox.x0, bbox.y0, bbox.x1 - bbox.x0, bbox.y1 - bbox.y0];
    return imageToViewportBBox(imageBox, imageWidth, imageHeight, viewport);
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }

  getInitializationDiagnostics(): DetectorDiagnostics {
    return this.worker
      ? { available: true, latencyMs: this.initializationLatencyMs }
      : { available: false, error: this.initializationError ?? "Tesseract worker not initialized" };
  }
}
