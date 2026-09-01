import type { Action } from "../types/index.js";

const ACTION_TYPES = new Set(["click", "scroll", "focus", "type_placeholder", "navigate_safe"]);

/** Validates server actions before they are forwarded to the page. */
export function validateAction(action: Action): { ok: true } | { ok: false; error: string } {
  if (!ACTION_TYPES.has(action.type)) return { ok: false, error: "Unsupported server action" };
  if (typeof action.target !== "string" || action.target.length === 0 || action.target.length > 128) return { ok: false, error: "Invalid action target" };
  if (/^(javascript|data|vbscript):/i.test(action.target)) return { ok: false, error: "Unsafe action target" };
  if (action.type === "navigate_safe") {
    try {
      const url = new URL(action.target);
      if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "Unsafe navigation protocol" };
    } catch { return { ok: false, error: "Invalid navigation URL" }; }
  } else if (!/^[A-Za-z][A-Za-z0-9_:.\-]*$/.test(action.target)) {
    return { ok: false, error: "Server actions must target validated element IDs" };
  }
  return { ok: true };
}
