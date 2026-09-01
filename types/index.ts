// types/index.ts
// Shared type definitions across all PRIVIS modules

export type SensitiveCategory =
  | "EMAIL"
  | "PAN"
  | "AADHAAR"
  | "AMOUNT"
  | "PHONE"
  | "NAME"
  | "FACE"
  | "PASSWORD"
  | "QR"
  | "OCR_TEXT"
  | "SIGNATURE"
  | "ORG";

export type DetectionSource = "dom" | "vision" | "rule";

export type BoundingBox = [x: number, y: number, width: number, height: number];

export interface Detection {
  element_id: string;
  category: SensitiveCategory;
  bbox: BoundingBox;
  confidence: number;
  source: DetectionSource;
  metadata?: Record<string, unknown>;
}

export interface ElementMeta {
  element_id: string;
  tag: string;
  type: string | null;
  autocomplete?: string | null;
  role: string | null;
  label: string | null;
  text: string;
  bbox: BoundingBox;
}

export interface Viewport {
  w: number;
  h: number;
}

export interface BrowserState {
  url: string;
  title: string;
  viewport: Viewport;
}

export interface Action {
  type: "click" | "type" | string;
  target: string;
  value?: string;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export type PolicyGateDecision = "allow" | "human_approval" | "block";

export interface PolicyGateResult {
  decision: PolicyGateDecision;
  reason: string;
}

export interface CapturePackage {
  tabId: number;
  dataUrl: string;
  elements: ElementMeta[];
  detections: Detection[];
  browserState: BrowserState;
  diagnostics?: Record<string, unknown>;
}

export interface SanitizedContext {
  elements: ElementMeta[];
  browserState: BrowserState;
}

export interface SanitizedPackage {
  schemaVersion?: "1.0";
  goal: string;
  sanitizedScreenshot: string;
  sanitizedContext: SanitizedContext;
  redactions?: Array<Pick<Detection, "category" | "bbox" | "confidence" | "source">>;
  sanitized: true;
}

export interface StepResult {
  decision: PolicyGateDecision;
  reason: string;
  actions?: ActionResult[];
}

export interface CaptureRequestMessage {
  type: "capture.request";
}

export interface CaptureResponseMessage {
  type: "capture.response";
  payload: {
    elements: ElementMeta[];
    browserState: BrowserState;
    detections: Detection[];
  };
}

export interface ExecuteRequestMessage {
  type: "execute.request";
  payload: {
    actions: Action[];
  };
}

export interface ExecuteResponseMessage {
  type: "execute.response";
  payload: {
    results: ActionResult[];
  };
}

export interface PingMessage {
  type: "ping";
}

export interface PongMessage {
  type: "pong";
}

export type PrivisMessage =
  | CaptureRequestMessage
  | CaptureResponseMessage
  | ExecuteRequestMessage
  | ExecuteResponseMessage
  | PingMessage
  | PongMessage;

export type PrivisMessageType = PrivisMessage["type"];

