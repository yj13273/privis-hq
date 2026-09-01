// background/service-worker.ts
// MV3 Service Worker orchestrating the end-to-end pipeline.
//
// Pipeline Flow:
// 1. Capture Layer: Tab screenshot (memory-only) + Content script DOM package.
// 2. Local Privacy Vision Engine (DOM path): detectSensitive on extracted elements.
// 3. Sanitizer: structural placeholders (applyPlaceholders) + pixel redaction (redactVisual).
// 4. Policy Gate: Evaluate risk (Allow / Human Approval / Block).
// 5. Remote Agent: Transmit sanitized package only (never called unless the gate allows).
// 6. Local Executor: Execute actions locally on DOM.

<<<<<<< HEAD
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
=======
import type {
  Action,
  CapturePackage,
  CaptureResponseMessage,
  ElementMeta,
  StepResult,
} from "../types/index.js";
import { takeScreenshot } from "../utils/screenshot.js";
import { sendToContent } from "../utils/messaging.js";
import {
  detectSensitive,
  applyPlaceholders,
} from "../privacy/sanitizer/structural-redact.js";
import { redactVisual } from "../privacy/sanitizer/visual-redact.js";
import { decide } from "../privacy/policy-gate/policy-gate.js";
import { sendSanitized } from "../remote/client.js";
import { applyActions } from "../executor/local-executor.js";

// Toolbar clicks carry no typed goal; run with the demo default.
const DEFAULT_GOAL = "Submit the employee portal form";
>>>>>>> 2c04d9b03deeaf7a3cccb1d542bb1ea9812ffc02

/**
 * Coordinates tab screenshot and DOM extraction from content script,
 * then fuses DOM detections (Local Privacy Vision Engine, DOM path).
 * @param tabId Target tab ID
 */
<<<<<<< HEAD
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
=======
// Snapshot the content-script DOM package for a tab.
function domPackage(tabId: number): Promise<CaptureResponseMessage> {
  return sendToContent<CaptureResponseMessage>(tabId, { type: "capture.request" });
}

// Cheap, deterministic fingerprint of the DOM package. Element ids are stable
// across extractions (the content script keys them by DOM node), so equality
// here means the page did not change between snapshots.
function packageFingerprint(dom: CaptureResponseMessage): string {
  return JSON.stringify(dom.payload);
}

export async function capturePackage(tabId: number): Promise<CapturePackage> {
  const MAX_TRIES = 3;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    // Snapshot the DOM first, capture the screenshot of that same state, then
    // re-snapshot the DOM and require it to be unchanged. This guarantees the
    // detections always describe the pixels we redact — never detections from
    // one page state applied to another state's screenshot.
    const before = await domPackage(tabId);
    const { dataUrl } = await takeScreenshot(tabId);
    const after = await domPackage(tabId);
    if (packageFingerprint(before) === packageFingerprint(after)) {
      const { elements, browserState } = before.payload;
      return {
        tabId,
        dataUrl,
        elements,
        detections: detectSensitive(elements),
        browserState,
      };
    }
  }
  throw new Error(
    "capturePackage: page state kept changing between DOM snapshot and screenshot"
  );
}

// In-memory step cache for the HUD
const lastLiveSteps: Array<Record<string, unknown>> = [];

// Helper to broadcast step updates with rich data to the popup HUD
function broadcastHudStep(step: number, data: Record<string, unknown>) {
  const payload = { type: "hud.liveStep", step, ...data };
  if (step === 1) lastLiveSteps.length = 0;
  lastLiveSteps.push(payload);
  try {
    chrome.runtime.sendMessage(payload).catch(() => {
      // HUD popup might be closed; safe to ignore
    });
  } catch {
    // Ignore if no receiver
  }
>>>>>>> 2c04d9b03deeaf7a3cccb1d542bb1ea9812ffc02
}

/**
 * Executes a full step of the privacy-preserving agent loop.
 * @param tabId Target tab ID
 * @param goal Human prompt or task instruction
 */
export async function runStep(tabId: number, goal: string): Promise<StepResult> {
<<<<<<< HEAD
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
=======
  const pkg = await capturePackage(tabId);
  broadcastHudStep(1, {
    rawScreenshot: pkg.dataUrl,
    elementCount: pkg.elements.length,
    viewport: pkg.browserState.viewport,
  });

  // Vision Engine Detections
  broadcastHudStep(2, {
    detections: pkg.detections,
  });

  // Sanitizer: structural placeholders + in-memory visual redaction.
  const { sanitized, map } = applyPlaceholders(pkg.elements, pkg.detections);
  const sanitizedScreenshot = await redactVisual(
    pkg.dataUrl,
    pkg.detections,
    pkg.browserState.viewport
  );
  // Real value -> placeholder pairs, so the HUD can show the swap happening.
  // The map itself never leaves this device; only placeholders go to the agent.
  const swaps = sanitized
    .filter((el) => typeof map[el.element_id] === "string")
    .map((el) => ({ real: map[el.element_id], placeholder: el.text }));
  broadcastHudStep(3, {
    sanitizedScreenshot,
    rawScreenshot: pkg.dataUrl,
    swaps,
    detectionsCount: pkg.detections.length,
  });

  // Policy Gate: never call the remote unless the package is allowed out.
  const gate = decide({ detections: pkg.detections, browserState: pkg.browserState });
  broadcastHudStep(4, {
    decision: gate.decision,
    reason: gate.reason,
  });
  if (gate.decision !== "allow") {
    return { decision: gate.decision, reason: gate.reason };
  }

  // Remote Agent: only the sanitized package crosses the wire — never the raw
  // dataUrl, never the element_id -> real value map. applyPlaceholders swaps
  // only `text`, so strip the user-controlled `label` (accessible label /
  // placeholder / title) to keep any raw value out of the remote context.
  const remoteElements: ElementMeta[] = sanitized.map((el) => ({ ...el, label: null }));
  const actions: Action[] = await sendSanitized({
    goal,
    sanitizedScreenshot,
    sanitizedContext: { elements: remoteElements, browserState: pkg.browserState },
  });
  broadcastHudStep(5, {
    goal,
    actions,
  });

  // Local Executor: apply the returned actions on the real page DOM.
  const results = await applyActions(tabId, actions);
  broadcastHudStep(6, {
    actions,
    results,
  });

  return { decision: gate.decision, reason: gate.reason, actions: results };
>>>>>>> 2c04d9b03deeaf7a3cccb1d542bb1ea9812ffc02
}

// Toolbar click → one full step on the active tab, default goal.
chrome.action.onClicked.addListener((tab) => {
  if (typeof tab.id !== "number") return;
  runStep(tab.id, DEFAULT_GOAL).catch((err: unknown) => {
    console.error(
      "PRIVIS runStep (toolbar) failed:",
      err instanceof Error ? err.message : String(err)
    );
  });
});

// Expose on self and globalThis for DevTools service worker console testing
const privisAPI = {
  takeScreenshot,
  capturePackage,
  runStep,
};
(globalThis as unknown as { privis: unknown }).privis = privisAPI;
if (typeof self !== "undefined") {
  (self as unknown as { privis: unknown }).privis = privisAPI;
}


// Plus the pre-existing { type: "PRIVIS_CAPTURE_SCREENSHOT", tabId } → { dataUrl }.
// Both are in-memory only.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "hud.getLatestSteps") {
    sendResponse({ steps: lastLiveSteps });
    return false;
  }
  if (msg?.type === "privis.runStep" && typeof msg.tabId === "number") {
    const goal = typeof msg.goal === "string" && msg.goal ? msg.goal : DEFAULT_GOAL;
    runStep(msg.tabId, goal)
      .then(sendResponse)
      .catch((err: unknown) =>
        sendResponse({ error: err instanceof Error ? err.message : String(err) })
      );
    return true; // async response
  }
  if (msg?.type === "PRIVIS_CAPTURE_SCREENSHOT" && typeof msg.tabId === "number") {
    takeScreenshot(msg.tabId)
      .then((r) => sendResponse(r))
      .catch((err: unknown) =>
        sendResponse({ error: err instanceof Error ? err.message : String(err) })
      );
    return true; // async response
  }
  if (msg?.type === "PRIVIS_RUN_STEP" && typeof msg.goal === "string" && typeof _sender.tab?.id === "number") {
    runStep(_sender.tab.id, msg.goal).then(sendResponse).catch((err: unknown) => sendResponse({ decision: "block", reason: err instanceof Error ? err.message : "Pipeline failed closed" }));
    return true;
  }
  return false;
});
