// content/capture-content.js -> content/capture-content.ts
// Content Script (Page Context)
//
// Responsibilities:
// - Extracts visible DOM elements, metadata, and bounding boxes.
// - Detects sensitive fields and swaps them with stable placeholders (e.g., PAN_1, EMAIL_1).
// - Holds local mapping { element_id: real_value } strictly in memory.
// - Executes real DOM actions (clicks, keyboard input) on behalf of local executor.

import type {
  Action,
  ActionResult,
  BrowserState,
  CaptureRequestMessage,
  ElementMeta,
  ExecuteRequestMessage,
  ExecuteResponseMessage,
} from "../types/index.js";
import {
  collectBrowserState,
  extractElements,
  resolveGeneratedElement,
} from "../utils/dom-extractor.js";
import { isPrivisMessage } from "../utils/messaging.js";

// In-memory real value store for placeholder resolution (never sent upstream).
// The Sanitizer writes element_id -> real value; this executor only reads it.
const localValues: Record<string, string> = {};
let snapshotVersion = 0;

/**
 * Capture Layer content-script half: visible elements + browser state.
 * No placeholders, no clicks — those live elsewhere (Sanitizer / Local Executor).
 */
export function captureDom(): { elements: ElementMeta[]; browserState: BrowserState; snapshotVersion: number } {
  snapshotVersion += 1;
  return {
    elements: extractElements(snapshotVersion),
    browserState: collectBrowserState(),
    snapshotVersion,
  };
}

/**
 * Resolves a target selector or element id to a live DOM element.
 * @param target Element ID or CSS selector
 */
interface LiveTarget {
  css?: string;
  role?: string;
  name?: string;
  bbox?: [number, number, number, number];
}

function accessibleName(element: HTMLElement): string {
  const labelledBy = element.getAttribute("aria-labelledby")
    ?.split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
  const associatedLabel = element.id
    ? Array.from(document.querySelectorAll<HTMLLabelElement>("label"))
      .find((label) => label.htmlFor === element.id)?.textContent
    : undefined;
  const wrappingLabel = element.closest("label")?.textContent;
  return element.getAttribute("aria-label") || labelledBy || associatedLabel || wrappingLabel ||
    element.getAttribute("placeholder") || element.getAttribute("title") || element.textContent || "";
}

function liveTarget(locator: LiveTarget): HTMLElement | null {
  if (locator.css?.trim()) {
    try {
      return document.querySelector<HTMLElement>(locator.css) ?? null;
    } catch {
      return null;
    }
  }
  const normalized = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");
  const elements = Array.from(document.querySelectorAll<HTMLElement>("*"));
  return elements.find((element) => {
    const role = element.getAttribute("role") || (() => {
      switch (element.tagName) {
        case "BUTTON": return "button";
        case "A": return "link";
        case "TEXTAREA": return "textbox";
        case "SELECT": return "combobox";
        case "INPUT": {
          const type = (element as HTMLInputElement).type;
          return ["checkbox", "radio"].includes(type) ? type
            : ["button", "submit", "reset", "image"].includes(type) ? "button"
            : "textbox";
        }
        default: return null;
      }
    })();
    if (locator.role && (!role || normalized(role) !== normalized(locator.role))) return false;
    if (locator.name && normalized(accessibleName(element)) !== normalized(locator.name)) return false;
    if (locator.bbox) {
      const [bx, by, bw, bh] = locator.bbox;
      const rect = element.getBoundingClientRect();
      if (!(rect.x < bx + bw && bx < rect.x + rect.width && rect.y < by + bh && by < rect.y + rect.height)) return false;
    }
    return true;
  }) ?? null;
}

export function resolveTarget(target: string, locator?: LiveTarget): HTMLElement | null {
  if (locator) return liveTarget(locator);
  const generatedPrefix = "__privis_generated:";
  if (target.startsWith(generatedPrefix)) {
    return resolveGeneratedElement(target.slice(generatedPrefix.length));
  }

  const byId = document.getElementById(target);
  if (byId) return byId;

  let bySelector: HTMLElement | null = null;
  try {
    bySelector = document.querySelector<HTMLElement>(target);
  } catch {
    // Invalid CSS selector: fall through to the attribute lookup instead of throwing.
  }
  if (bySelector) return bySelector;

  return null;
}

// Stable per-category placeholder tokens produced by the Sanitizer (EMAIL_1, PAN_1, ...).
const PLACEHOLDER_RE = /^(EMAIL|PAN|AADHAAR|AMOUNT|PHONE|NAME)_\d+$/;

/**
 * Executes an action on the page DOM, substituting placeholders with real local values.
 * @param action The requested action (click, type, etc.)
 */
function failure(code: NonNullable<ActionResult["code"]>, error: string): ActionResult {
  return { ok: false, code, error };
}

function interactionFailure(el: HTMLElement): ActionResult | undefined {
  if ("disabled" in el && (el as HTMLInputElement).disabled) {
    return failure("NOT_INTERACTABLE", "Target is disabled");
  }
  const point = el.getBoundingClientRect?.();
  const top = point && document.elementFromPoint?.(point.x + point.width / 2, point.y + point.height / 2);
  if (top && top !== el && !el.contains(top)) {
    return failure("NOT_INTERACTABLE", "Target is covered by another element");
  }
  return undefined;
}

function timeoutMsFor(action: Action): number {
  return Math.min(Math.max(action.timeoutMs ?? 5000, 1), 30000);
}

async function waitFor(action: Action): Promise<ActionResult> {
  if (action.targetLocator?.css?.trim()) {
    try {
      document.querySelector(action.targetLocator.css);
    } catch {
      return failure("INVALID_ACTION", "Malformed CSS selector in wait target");
    }
  }
  const deadline = Date.now() + timeoutMsFor(action);
  const matches = (): boolean => {
    if (action.condition === "stable") return true;
    if (action.condition === "url") return window.location.href.includes(action.value ?? "");
    if (action.condition === "text") return document.body?.innerText.includes(action.value ?? "") ?? false;
    const element = resolveTarget(action.target ?? "", action.targetLocator);
    return action.condition === "gone" ? !element : Boolean(element);
  };

  let previousHtml = document.body?.innerHTML ?? "";
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    if (action.condition === "stable") {
      const currentHtml = document.body?.innerHTML ?? "";
      if (currentHtml !== previousHtml) {
        previousHtml = currentHtml;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 150) {
        return { ok: true };
      }
    } else if (matches()) {
      return { ok: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return failure("TIMEOUT", `Timed out waiting for ${action.condition}`);
}

export async function executeAction(action: Action): Promise<ActionResult> {
  if (action.type === "scroll") {
    if (typeof action.dy !== "number" || !Number.isFinite(action.dy)) {
      return failure("INVALID_ACTION", "Invalid scroll distance");
    }
    window.scrollBy({ top: action.dy, left: 0, behavior: "auto" });
    return { ok: true };
  }

  if (action.target === "__stale_reference") {
    return failure("STALE_REFERENCE", "Action references an older page snapshot");
  }
  if (action.type === "wait_for") return waitFor(action);
  if (action.type === "go_back" || action.type === "go_forward") {
    const direction = action.type === "go_back" ? "back" : "forward";
    window.addEventListener("popstate", () => {
      try {
        void chrome.runtime.sendMessage({ type: "history.transition", direction });
      } catch {
        // The orchestrator also observes full-document tab updates.
      }
    }, { once: true });
    window.history[action.type === "go_back" ? "back" : "forward"]();
    return { ok: true };
  }
  if (action.type === "reload") {
    window.location.reload();
    return { ok: true };
  }

  const el = resolveTarget(action.target ?? "");
  if (!el) return failure("TARGET_NOT_FOUND", `Target not found: ${action.target ?? ""}`);
  const blocked = interactionFailure(el);
  if (blocked) return blocked;

  switch (action.type) {
    case "click":
      el.click();
      return { ok: true };

    case "focus":
      el.focus();
      return { ok: true };

    case "hover":
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      return { ok: true };

    case "clear":
      if (!("value" in el)) return failure("NOT_INTERACTABLE", `Cannot clear non-form element: ${action.target}`);
      (el as HTMLInputElement).value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };

    case "press_key": {
      if (!action.key) return failure("INVALID_ACTION", "Missing key");
      const control = action.key === "Control+A";
      const key = control ? "a" : action.key === "Shift+Tab" ? "Tab" : action.key;
      const init = { key, code: key, bubbles: true, cancelable: true, ctrlKey: control, shiftKey: action.key === "Shift+Tab" };
      const down = new KeyboardEvent("keydown", init);
      el.dispatchEvent(down);
      if (down.defaultPrevented) return { ok: true };

      const field = el as HTMLInputElement | HTMLTextAreaElement;
      const hasSelection = typeof field.selectionStart === "number" && typeof field.selectionEnd === "number";
      let handled = false;
      const replaceSelection = (value: string) => {
        if (!hasSelection) return false;
        const start = field.selectionStart ?? value.length;
        const end = field.selectionEnd ?? start;
        field.value = `${field.value.slice(0, start)}${value}${field.value.slice(end)}`;
        field.setSelectionRange(start + value.length, start + value.length);
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      };

      if (control && hasSelection) {
        field.setSelectionRange(0, field.value.length);
        handled = true;
      } else if ((action.key === "Backspace" || action.key === "Delete") && hasSelection) {
        const start = field.selectionStart ?? 0;
        const end = field.selectionEnd ?? start;
        if (start !== end) {
          handled = replaceSelection("");
        } else if (action.key === "Backspace" && start > 0) {
          field.setSelectionRange(start - 1, start);
          handled = replaceSelection("");
        } else if (action.key === "Delete" && start < field.value.length) {
          field.setSelectionRange(start, start + 1);
          handled = replaceSelection("");
        }
      } else if (action.key === "Enter") {
        const tagName = el.tagName?.toUpperCase();
        const inputType = (el as HTMLInputElement).type?.toLowerCase();
        if (tagName === "BUTTON" || tagName === "A" ||
            (tagName === "INPUT" && ["button", "submit", "reset", "image"].includes(inputType))) {
          el.click();
          handled = true;
        } else if (!(typeof HTMLTextAreaElement !== "undefined" && el instanceof HTMLTextAreaElement) && "form" in el && (el as HTMLInputElement).form) {
          (el as HTMLInputElement).form?.requestSubmit();
          handled = true;
        } else if (typeof HTMLTextAreaElement !== "undefined" && el instanceof HTMLTextAreaElement) {
          handled = replaceSelection("\n");
        }
      } else if (action.key === "Tab" || action.key === "Shift+Tab") {
        const focusable = Array.from(document.querySelectorAll<HTMLElement>(
          "input, textarea, select, button, a, [tabindex]:not([tabindex='-1'])"
        ));
        const index = focusable.indexOf(el);
        const next = focusable[index + (action.key === "Shift+Tab" ? -1 : 1)];
        if (next) {
          next.focus();
          handled = true;
        }
      } else if (el instanceof HTMLSelectElement && (action.key === "ArrowUp" || action.key === "ArrowDown")) {
        const delta = action.key === "ArrowDown" ? 1 : -1;
        el.selectedIndex = Math.max(0, Math.min(el.options.length - 1, el.selectedIndex + delta));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        handled = true;
      } else if ((action.key === "ArrowLeft" || action.key === "ArrowRight") && hasSelection) {
        const position = field.selectionStart ?? 0;
        const end = field.selectionEnd ?? position;
        const next = position !== end
          ? (action.key === "ArrowLeft" ? position : end)
          : Math.max(0, Math.min(field.value.length, position + (action.key === "ArrowRight" ? 1 : -1)));
        field.setSelectionRange(next, next);
        handled = true;
      }
      el.dispatchEvent(new KeyboardEvent("keyup", init));
      return handled ? { ok: true } : failure("UNSUPPORTED_CONTROL", `Key ${action.key} has no supported effect on target`);
    }

    case "select_option": {
      if (!(el instanceof HTMLSelectElement)) return failure("UNSUPPORTED_CONTROL", `Not a select element: ${action.target}`);
      const option = Array.from(el.options).find((candidate) => candidate.value === action.value || candidate.textContent?.trim() === action.value);
      if (!option) return failure("TARGET_NOT_FOUND", `Option not found: ${action.value}`);
      el.value = option.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }

    case "check":
    case "uncheck": {
      if (!(el instanceof HTMLInputElement) || !["checkbox", "radio"].includes(el.type)) {
        return failure("UNSUPPORTED_CONTROL", `Not a checkbox or radio: ${action.target}`);
      }
      if (action.type === "uncheck" && el.type === "radio") {
        return failure("UNSUPPORTED_CONTROL", "Radio buttons cannot be unchecked");
      }
      const desired = action.type === "check";
      if (el.checked !== desired) el.click();
      if (el.checked !== desired) return failure("NOT_INTERACTABLE", `Could not set control state: ${action.target}`);
      return { ok: true };
    }

    case "type": {
      let value = action.value ?? "";
      if (PLACEHOLDER_RE.test(value)) {
        const elementId = el.id || el.dataset.privisId || "";
        if (Object.hasOwn(localValues, elementId)) {
          value = localValues[elementId];
        } else {
          return failure("INVALID_ACTION", `Missing local value for placeholder: ${value}`);
        }
      }
      if (!("value" in el)) return failure("NOT_INTERACTABLE", `Cannot type into non-form element: ${action.target}`);
      const field = el as HTMLInputElement;
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }

    default:
      return failure("UNSUPPORTED_CONTROL", `Unsupported action type: ${action.type}`);
  }
}

function isExecuteRequest(message: unknown): message is ExecuteRequestMessage {
  // Reuse the shared validator: rejects malformed execute messages (missing
  // payload, non-array/malformed actions) before payload.actions is touched.
  return isPrivisMessage(message) && message.type === "execute.request";
}

function isCaptureRequest(message: unknown): message is CaptureRequestMessage {
  return isPrivisMessage(message) && message.type === "capture.request";
}

// Capture channel for the Capture Layer: returns the DOM package (elements +
// browser state) to the background on request. Wired by the orchestrator (#15);
// the background half lives in background/service-worker.ts.
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isCaptureRequest(message)) return false;
  sendResponse({ type: "capture.response", payload: captureDom() });
  return false;
});

async function executeActions(actions: Action[]): Promise<ExecuteResponseMessage> {
  const results: ActionResult[] = [];
  for (const action of actions) {
    const result = await executeAction(action);
    results.push(result);
    if (!result.ok) break; // stop on first failure
  }
  return { type: "execute.response", payload: { results } };
}

// Execute channel for the Local Executor: applies gate-approved actions to the
// real page DOM and replies with per-action results (stops on first failure).
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isExecuteRequest(message)) return false;
  void executeActions(message.payload.actions).then(sendResponse);
  return true; // keep the channel open for the async response
});
