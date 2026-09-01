// background/service-worker.ts
// MV3 Service Worker orchestrating the end-to-end pipeline.
//
// Pipeline Flow:
// 1. Capture Layer: Tab screenshot (memory-only) + Content script DOM package.
// 2. Policy Gate: Evaluate risk (Allow / Human Approval / Block).
// 3. Sanitizer: Redact screenshot pixels via OffscreenCanvas + swap structural DOM placeholders.
// 4. Remote Agent: Transmit sanitized package only.
// 5. Local Executor: Execute actions locally on DOM.

import type { CapturePackage, CaptureResponseMessage, StepResult } from "../types/index.js";
import { takeScreenshot } from "../utils/screenshot.js";
import { sendToContent } from "../utils/messaging.js";
import type { VisionEngine } from "../privacy/engine/vision-engine.js";
import { VisionEngine as LocalVisionEngine } from "../privacy/engine/vision-engine.js";
import { TesseractOcrDetector } from "../privacy/engine/ocr-detector.js";
import { QrDetector } from "../privacy/engine/qr-detector.js";
import { FaceDetector } from "../privacy/engine/face-detector.js";
import { MergeEngine } from "../privacy/merge/merge-engine.js";
import { sanitizeCapture } from "../privacy/sanitizer/package-sanitizer.js";
import { assertSanitizedPackage } from "../privacy/policy-gate/privacy-gate.js";
import { RemoteClient } from "../remote/client.js";
import { applyActions } from "../executor/local-executor.js";

const defaultVisionEngine = new LocalVisionEngine([
  new TesseractOcrDetector(),
  new QrDetector(),
  new FaceDetector(),
]);

/**
 * Coordinates tab screenshot and DOM extraction from content script.
 * @param tabId Target tab ID
 */
export async function capturePackage(tabId: number, visionEngine: VisionEngine = defaultVisionEngine): Promise<CapturePackage> {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("capturePackage: invalid tabId");
  const [screenshot, content] = await Promise.all([
    takeScreenshot(tabId),
    sendToContent<CaptureResponseMessage>(tabId, { type: "capture.request" }),
  ]);
  const vision = visionEngine ? await visionEngine.run({
    image: screenshot.dataUrl,
    width: screenshot.width,
    height: screenshot.height,
    viewport: content.payload.browserState.viewport,
  }) : null;
  return {
    tabId,
    dataUrl: screenshot.dataUrl,
    elements: content.payload.elements,
    detections: [...content.payload.detections, ...(vision?.detections.map((d) => ({
      element_id: d.metadata?.element_id ? String(d.metadata.element_id) : `${d.category.toLowerCase()}-${Math.round(d.bbox[0])}-${Math.round(d.bbox[1])}`,
      category: d.category as CapturePackage["detections"][number]["category"],
      bbox: d.bbox,
      confidence: d.confidence,
      source: d.source,
      metadata: d.metadata,
    })) ?? [])],
    browserState: content.payload.browserState,
    diagnostics: vision?.diagnostics,
  };
}

/**
 * Executes a full step of the privacy-preserving agent loop.
 * @param tabId Target tab ID
 * @param goal Human prompt or task instruction
 */
export async function runStep(tabId: number, goal: string): Promise<StepResult> {
  if (!goal.trim()) return { decision: "block", reason: "Goal is required" };
  try {
    const capture = await capturePackage(tabId);
    capture.detections = new MergeEngine({ minConfidence: 0.5 }).merge(capture.detections);
    const sanitized = await sanitizeCapture(capture, goal);
    assertSanitizedPackage(sanitized);
    const actions = await new RemoteClient().analyze(sanitized);
    const results = await applyActions(tabId, actions);
    return {
      decision: results.every((result) => result.ok) ? "allow" : "block",
      reason: results.every((result) => result.ok) ? "Sanitized request analyzed and action executed locally" : "Local action execution failed",
      actions: results,
    };
  } catch (error) {
    return { decision: "block", reason: error instanceof Error ? error.message : "Privacy pipeline failed closed" };
  }
}

// Thin manual-test hook: { type: "PRIVIS_CAPTURE_SCREENSHOT", tabId } → { dataUrl }.
// In-memory only; full runStep pipeline lands in its own issue.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "PRIVIS_CAPTURE_SCREENSHOT" && typeof msg.tabId === "number") {
    takeScreenshot(msg.tabId)
      .then((r) => sendResponse(r))
      .catch((err: unknown) => sendResponse({ error: err instanceof Error ? err.message : String(err) }));
    return true; // async response
  }
  if (msg?.type === "PRIVIS_RUN_STEP" && typeof msg.goal === "string" && typeof _sender.tab?.id === "number") {
    runStep(_sender.tab.id, msg.goal).then(sendResponse).catch((err: unknown) => sendResponse({ decision: "block", reason: err instanceof Error ? err.message : "Pipeline failed closed" }));
    return true;
  }
  return false;
});
