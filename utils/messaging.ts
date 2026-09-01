// utils/messaging.ts
// Typed message passing helpers between background service worker and content scripts

import type { PrivisMessage } from "../types/index.js";

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null;
}

function isBoundingBox(val: unknown): boolean {
  return (
    Array.isArray(val) &&
    val.length === 4 &&
    val.every((n) => typeof n === "number" && !Number.isNaN(n))
  );
}

function isElementMeta(val: unknown): boolean {
  if (!isObject(val)) return false;
  return (
    typeof val.element_id === "string" &&
    typeof val.tag === "string" &&
    (val.type === null || typeof val.type === "string") &&
    (val.autocomplete === undefined || val.autocomplete === null || typeof val.autocomplete === "string") &&
    (val.role === null || typeof val.role === "string") &&
    (val.label === null || typeof val.label === "string") &&
    typeof val.text === "string" &&
    isBoundingBox(val.bbox)
  );
}

function isBrowserState(val: unknown): boolean {
  if (!isObject(val)) return false;
  return (
    typeof val.url === "string" &&
    typeof val.title === "string" &&
    isObject(val.viewport) &&
    typeof val.viewport.w === "number" &&
    !Number.isNaN(val.viewport.w) &&
    typeof val.viewport.h === "number" &&
    !Number.isNaN(val.viewport.h)
  );
}

function isDetection(val: unknown): boolean {
  if (!isObject(val)) return false;
  return (
    typeof val.element_id === "string" &&
    typeof val.category === "string" &&
    isBoundingBox(val.bbox) &&
    typeof val.confidence === "number" &&
    val.confidence >= 0 && val.confidence <= 1 &&
    (val.source === "dom" || val.source === "vision")
  );
}

function isAction(val: unknown): boolean {
  if (!isObject(val)) return false;
  return (
    typeof val.type === "string" &&
    typeof val.target === "string" &&
    (val.value === undefined || typeof val.value === "string")
  );
}

function isActionResult(val: unknown): boolean {
  if (!isObject(val)) return false;
  return (
    typeof val.ok === "boolean" &&
    (val.error === undefined || typeof val.error === "string")
  );
}

/**
 * Type guard to validate whether an unknown value is a valid PrivisMessage and has valid payloads.
 */
export function isPrivisMessage(message: unknown): message is PrivisMessage {
  if (!isObject(message)) {
    return false;
  }
  const candidate = message as { type?: unknown; payload?: unknown };
  if (typeof candidate.type !== "string") {
    return false;
  }

  switch (candidate.type) {
    case "ping":
    case "pong":
    case "capture.request":
      return true;

    case "capture.response": {
      if (!isObject(candidate.payload)) return false;
      const payload = candidate.payload;
      return (
        Array.isArray(payload.elements) &&
        payload.elements.every(isElementMeta) &&
        isBrowserState(payload.browserState) &&
        Array.isArray(payload.detections) &&
        payload.detections.every(isDetection)
      );
    }

    case "execute.request": {
      if (!isObject(candidate.payload)) return false;
      return Array.isArray(candidate.payload.actions) && candidate.payload.actions.every(isAction);
    }

    case "execute.response": {
      if (!isObject(candidate.payload)) return false;
      return Array.isArray(candidate.payload.results) && candidate.payload.results.every(isActionResult);
    }

    default:
      return false;
  }
}

/**
 * Sends a message from the background service worker to a specific tab's content script.
 * Auto-injects content scripts if the tab was open before an extension reload.
 * @param tabId Target tab ID
 * @param message Message payload
 */
export async function sendToContent<T = unknown>(tabId: number, message: PrivisMessage): Promise<T> {
  if (!isPrivisMessage(message)) {
    throw new Error(`Invalid PrivisMessage: ${String((message as { type?: unknown })?.type ?? message)}`);
  }
  if (typeof chrome === "undefined" || !chrome.tabs?.sendMessage) {
    throw new Error("chrome.tabs.sendMessage is not available");
  }
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as T;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (
      errorMsg.includes("Could not establish connection") &&
      typeof chrome.scripting?.executeScript === "function"
    ) {
      // Auto-inject content scripts into the tab if it was opened before extension reload
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [
          "dist/utils/dom-extractor.js",
          "dist/privacy/sanitizer/structural-redact.js",
          "dist/content/capture-content.js",
        ],
      });
      // Retry message delivery
      return (await chrome.tabs.sendMessage(tabId, message)) as T;
    }
    throw err;
  }
}

/**
 * Sends a message from a content script to the background service worker.
 * @param message Message payload
 */
export async function sendToBackground<T = unknown>(message: PrivisMessage): Promise<T> {
  if (!isPrivisMessage(message)) {
    throw new Error(`Invalid PrivisMessage: ${String((message as { type?: unknown })?.type ?? message)}`);
  }
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    throw new Error("chrome.runtime.sendMessage is not available");
  }
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

