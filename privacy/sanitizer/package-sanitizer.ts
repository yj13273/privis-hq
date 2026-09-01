import type { CapturePackage, Detection, SanitizedPackage } from "../../types/index.js";
import { applyPlaceholders } from "./structural-redact.js";
import { redactVisual } from "./visual-redact.js";

/** Builds the only package permitted to cross the remote boundary. */
export async function sanitizeCapture(capture: CapturePackage, goal: string): Promise<SanitizedPackage> {
  const detections = capture.detections.filter((d) => d.bbox[2] > 0 && d.bbox[3] > 0);
  const structural = applyPlaceholders(capture.elements, detections);
  const sanitizedScreenshot = await redactVisual(capture.dataUrl, detections, capture.browserState.viewport);
  if (!sanitizedScreenshot || sanitizedScreenshot === capture.dataUrl) throw new Error("Sanitization did not produce a new screenshot");
  let safeUrl = capture.browserState.url;
  try {
    const parsed = new URL(safeUrl);
    parsed.search = "";
    parsed.hash = "";
    safeUrl = parsed.toString();
  } catch {
    safeUrl = "about:blank";
  }
  const sanitizedContext = { elements: structural.sanitized, browserState: { ...capture.browserState, url: safeUrl } };
  return {
    schemaVersion: "1.0",
    sanitized: true,
    goal,
    sanitizedScreenshot,
    sanitizedContext,
    redactions: detections.map(({ category, bbox, confidence, source }) => ({ category, bbox, confidence, source })),
  };
}

export function containsRawSensitiveText(value: unknown): boolean {
  const text = JSON.stringify(value);
  return /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\+?\d[\d\s().-]{8,}\d|(?:\d[ -]*?){13,19}|secretpassword/i.test(text);
}
