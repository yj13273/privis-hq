// utils/dom-extractor.ts
// Content-script DOM metadata extraction helper (Capture Layer)
//
// Responsibilities:
// - Finds visible interactive elements, labels, and bounding boxes.
// - Collects high-level page and viewport dimensions.

import type { BrowserState, ElementMeta } from "../types/index.js";

const INTERACTIVE_SELECTOR =
  "input, textarea, select, button, [role='button'], img";

// Stable per-element ids: an element keeps the same generated id across
// repeated extractions within the page's lifetime.
const elementIds = new WeakMap<Element, string>();
let generatedIdCounter = 0;

function elementId(el: Element): string {
  if (el.id) return el.id;
  let id = elementIds.get(el);
  if (!id) {
    id = `el-${el.tagName.toLowerCase()}-${++generatedIdCounter}`;
    elementIds.set(el, id);
  }
  return id;
}

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}

function roundBBox(rect: DOMRect): ElementMeta["bbox"] {
  return [
    Math.round(rect.x),
    Math.round(rect.y),
    Math.round(rect.width),
    Math.round(rect.height),
  ];
}

/**
 * Finds accessible label or placeholder associated with an element.
 * @param el DOM element
 */
export function labelFor(el: HTMLElement): string | null {
  if (el.id) {
    const byFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (byFor?.textContent?.trim()) return byFor.textContent.trim();
  }
  const wrapped = el.closest("label");
  if (wrapped?.textContent?.trim()) return wrapped.textContent.trim();
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    const text = labelledby
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .join(" ")
      .trim();
    if (text) return text;
  }
  return (
    el.getAttribute("aria-label") ??
    (el as HTMLInputElement).placeholder ??
    el.getAttribute("title") ??
    null
  );
}

/**
 * Extracts visible interactive elements, media, and form controls.
 */
export function extractElements(): ElementMeta[] {
  const out: ElementMeta[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)) {
    if (!isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    const input = el as HTMLInputElement;
    // Password values are never extracted (contract rule); other controls
    // report .value so DOM detection can see what the field holds.
    const isControl =
      el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
    const text =
      el.tagName === "INPUT" && input.type === "password"
        ? ""
        : isControl
          ? (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value
          : (el.textContent ?? "").trim();
    out.push({
      element_id: elementId(el),
      tag: el.tagName.toLowerCase(),
      type: el.tagName === "INPUT" ? (input.type || null) : null,
      autocomplete: el.getAttribute("autocomplete"),
      role: el.getAttribute("role"),
      label: labelFor(el),
      text,
      bbox: roundBBox(rect),
    });
  }
  return out;
}

/**
 * Collects high-level page metadata and viewport dimensions.
 */
export function collectBrowserState(): BrowserState {
  return {
    url: window.location.href,
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
}
