// utils/dom-extractor.ts
// Content-script DOM metadata extraction helper (Capture Layer)
//
// Responsibilities:
// - Finds visible interactive elements, labels, and bounding boxes.
// - Collects high-level page and viewport dimensions.

import type { BrowserState, ElementMeta } from "../types/index.js";

const INTERACTIVE_SELECTOR =
  "a, input, textarea, select, button, img, [role], [contenteditable='true']";

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

export function implicitRole(el: HTMLElement): string | null {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  switch (el.tagName) {
    case "A": return "link";
    case "BUTTON": return "button";
    case "TEXTAREA": return "textbox";
    case "SELECT": return "combobox";
    case "INPUT": {
      const type = (el as HTMLInputElement).type;
      if (type === "checkbox" || type === "radio") return type;
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      return "textbox";
    }
    default:
      return el.isContentEditable ? "textbox" : null;
  }
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
/** Resolves an in-memory generated id without mutating the page DOM. */
export function resolveGeneratedElement(id: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)) {
    if (!el.id && elementId(el) === id) return el;
  }
  return null;
}

export function extractElements(snapshotVersion?: number): ElementMeta[] {
  const out: ElementMeta[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)) {
    if (!isVisible(el)) continue;
    const id = elementId(el);
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
    const parent = el.parentElement?.matches(INTERACTIVE_SELECTOR) ? el.parentElement : undefined;
    const ariaChecked = el.getAttribute("aria-checked");
    const ariaSelected = el.getAttribute("aria-selected");
    const ariaExpanded = el.getAttribute("aria-expanded");
    out.push({
      element_id: id,
      tag: el.tagName.toLowerCase(),
      type: el.tagName === "INPUT" ? (input.type || null) : null,
      role: implicitRole(el),
      label: labelFor(el),
      text,
      bbox: roundBBox(rect),
      ...(snapshotVersion !== undefined ? { snapshotVersion } : {}),
      disabled: "disabled" in el ? Boolean((el as HTMLInputElement).disabled) : ariaDisabled(el),
      ...(ariaChecked !== null || ["checkbox", "radio"].includes(input.type)
        ? { checked: ariaChecked !== null ? ariaChecked === "true" : input.checked }
        : {}),
      ...(ariaSelected !== null || el.tagName === "OPTION"
        ? { selected: ariaSelected !== null ? ariaSelected === "true" : (el as HTMLOptionElement).selected }
        : {}),
      ...(ariaExpanded !== null ? { expanded: ariaExpanded === "true" } : {}),
      focused: document.activeElement === el,
      ...(parent ? { parentElementId: elementId(parent) } : {}),
      generated: !el.id,
    });
  }
  return out;
}

function ariaDisabled(el: HTMLElement): boolean {
  return el.getAttribute("aria-disabled") === "true";
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
