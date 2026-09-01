import type { BoundingBox, DetectionSource } from "../../types/index.js";

export interface VisionFrame {
  /** Existing capture representation: screenshot data URL, ImageData, or a browser image source. */
  image: string | ImageData | HTMLCanvasElement | ImageBitmap | HTMLImageElement;
  width: number;
  height: number;
  viewport: { w: number; h: number };
}

export interface VisionDetection {
  element_id: string;
  bbox: BoundingBox;
  category: string;
  confidence: number;
  source: DetectionSource;
  metadata?: Record<string, unknown>;
}

export interface DetectorDiagnostics {
  available: boolean;
  latencyMs?: number;
  error?: string;
}

export interface VisionDetectorResult {
  detections: VisionDetection[];
  diagnostics: DetectorDiagnostics;
}

export interface VisionDetector {
  readonly name: string;
  isAvailable(): boolean;
  initialize(): Promise<void>;
  detect(frame: VisionFrame, context?: unknown): Promise<VisionDetectorResult>;
  dispose(): Promise<void>;
}

export function unavailableResult(error: string): VisionDetectorResult {
  return { detections: [], diagnostics: { available: false, error } };
}
