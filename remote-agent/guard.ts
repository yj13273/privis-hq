// remote-agent/guard.ts
// CBA-3 Guard: Validates model outputs, rejects raw PII / illegal actions,
// and fails closed to ask_human before Local Executor runs.

import type { SanitizedPackage, SanitizedContext } from "../types/index.js";
import {
  type AgentAction,
  type AskHumanAction,
  type Target,
  ALLOWED_KEYS,
  PII_PATTERNS,
  PLACEHOLDER_TOKEN_REGEX,
  isTarget,
} from "./types.js";

export interface GuardOptions {
  allowlist?: Set<string> | string[];
  sanitizedPackage?: SanitizedPackage;
  sanitizedContext?: SanitizedContext;
}

export interface GuardSuccess {
  ok: true;
  action: AgentAction;
}

export interface GuardFailure {
  ok: false;
  error: string;
  fallbackAction: AskHumanAction;
}

export type GuardResult = GuardSuccess | GuardFailure;

const ALLOWED_NAVIGATE_PROTOCOLS = ["http:", "https:"];
const FORBIDDEN_RAW_KEYS = ["value", "text", "input", "val", "content", "password", "secret"];

/**
 * Replaces PII pattern matches with [REDACTED_<NAME>] markers so a string is
 * safe to embed in a fallback reason (which flows back into the next prompt
 * via lastStepResult) or any operator-facing surface. Category names survive;
 * raw values do not.
 */
export function redactPii(text: string): string {
  let out = text;
  for (const { name, re } of PII_PATTERNS) {
    out = out.replace(re, `[REDACTED_${name}]`);
  }
  return out;
}

/**
 * Extracts all valid placeholder tokens present in a sanitized context.
 */
export function getPlaceholderAllowlistFromContext(
  context?: SanitizedContext | null
): Set<string> {
  const allowlist = new Set<string>();
  if (!context || !Array.isArray(context.elements)) {
    return allowlist;
  }

  for (const el of context.elements) {
    if (typeof el.text === "string") {
      const trimmed = el.text.trim();
      if (PLACEHOLDER_TOKEN_REGEX.test(trimmed)) {
        allowlist.add(trimmed);
      }
    }
  }
  return allowlist;
}

/**
 * Unwraps markdown code fences or single-action wrappers.
 * Rejects multi-action arrays immediately.
 */
function normalizeRawOutput(input: unknown): unknown {
  let val = input;
  if (typeof val === "string") {
    let clean = val.trim();
    if (clean.startsWith("```")) {
      clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    }
    try {
      val = JSON.parse(clean);
    } catch (err) {
      throw new Error(`Invalid JSON output from model: ${(err as Error).message}`);
    }
  }

  if (Array.isArray(val)) {
    throw new Error(
      `Multiple actions detected (${val.length}) — model must return exactly one action per step`
    );
  }

  if (typeof val === "object" && val !== null) {
    const record = val as Record<string, unknown>;
    if (Array.isArray(record.actions)) {
      throw new Error(
        `Multiple actions detected in 'actions' array (${record.actions.length}) — exactly one action allowed`
      );
    }
    if ("action" in record && typeof record.action === "object" && record.action !== null) {
      if (Array.isArray(record.action)) {
        throw new Error("Multiple actions detected in 'action' wrapper — exactly one action allowed");
      }
      val = record.action;
    } else if (
      "agent_action" in record &&
      typeof record.agent_action === "object" &&
      record.agent_action !== null
    ) {
      if (Array.isArray(record.agent_action)) {
        throw new Error(
          "Multiple actions detected in 'agent_action' wrapper — exactly one action allowed"
        );
      }
      val = record.agent_action;
    }
  }

  return val;
}

/**
 * Resolves the active placeholder allowlist from options.
 */
function resolveAllowlist(options?: GuardOptions): Set<string> | null {
  if (!options) return null;
  if (options.allowlist) {
    return options.allowlist instanceof Set
      ? options.allowlist
      : new Set(options.allowlist);
  }
  if (options.sanitizedPackage?.sanitizedContext) {
    return getPlaceholderAllowlistFromContext(options.sanitizedPackage.sanitizedContext);
  }
  if (options.sanitizedContext) {
    return getPlaceholderAllowlistFromContext(options.sanitizedContext);
  }
  return null;
}

/**
 * Scans an arbitrary string or object for raw PII patterns.
 */
export function findPiiInValue(val: unknown): string | null {
  if (typeof val === "string") {
    for (const { name, re } of PII_PATTERNS) {
      if (re.test(val)) {
        return name;
      }
    }
  } else if (typeof val === "object" && val !== null) {
    for (const v of Object.values(val)) {
      const match = findPiiInValue(v);
      if (match) return match;
    }
  }
  return null;
}

/**
 * Validates candidate object against Guard rules and schema.
 */
function validateActionWithGuard(
  candidate: unknown,
  allowlist: Set<string> | null,
  goalText = ""
): { ok: true; action: AgentAction } | { ok: false; error: string } {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return { ok: false, error: "Action must be a non-null JSON object" };
  }

  const obj = candidate as Record<string, unknown>;

  if (typeof obj.type !== "string" || obj.type.trim().length === 0) {
    return { ok: false, error: "Missing or invalid 'type' property in action" };
  }

  // Check for raw values accidentally included in top-level action object
  for (const rawKey of FORBIDDEN_RAW_KEYS) {
    if (rawKey in obj) {
      return {
        ok: false,
        error: `Forbidden raw field '${rawKey}' present in action — must never send raw data`,
      };
    }
  }

  switch (obj.type) {
    case "navigate": {
      if (typeof obj.url !== "string" || obj.url.trim().length === 0) {
        return { ok: false, error: "'navigate' action requires a non-empty 'url' string" };
      }
      const rawUrl = obj.url.trim();
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(rawUrl);
      } catch {
        return { ok: false, error: `Invalid URL format in navigate action: "${rawUrl}"` };
      }

      if (!ALLOWED_NAVIGATE_PROTOCOLS.includes(parsedUrl.protocol)) {
        return {
          ok: false,
          error: `Disallowed URL protocol "${parsedUrl.protocol}" in navigate action — only http: and https: allowed`,
        };
      }

      const piiMatch = findPiiInValue(rawUrl);
      if (piiMatch) {
        return {
          ok: false,
          error: `Raw ${piiMatch} detected in navigate URL: "${rawUrl}"`,
        };
      }

      return { ok: true, action: { type: "navigate", url: rawUrl } };
    }

    case "open_tab": {
      if (obj.url !== undefined && (typeof obj.url !== "string" || !obj.url.trim())) {
        return { ok: false, error: "'open_tab' url must be a non-empty string when provided" };
      }
      if (typeof obj.url === "string") {
        let parsed: URL;
        try { parsed = new URL(obj.url.trim()); } catch { return { ok: false, error: "Invalid URL in open_tab action" }; }
        if (!ALLOWED_NAVIGATE_PROTOCOLS.includes(parsed.protocol)) {
          return { ok: false, error: "'open_tab' only supports http: and https: URLs" };
        }
        const pii = findPiiInValue(obj.url);
        if (pii) return { ok: false, error: `Raw ${pii} detected in open_tab URL` };
        return { ok: true, action: { type: "open_tab", url: parsed.toString() } };
      }
      return { ok: true, action: { type: "open_tab" } };
    }

    case "switch_tab": {
      if (typeof obj.tabRef !== "string" || !obj.tabRef.trim()) {
        return { ok: false, error: "'switch_tab' requires an opaque tabRef" };
      }
      return { ok: true, action: { type: "switch_tab", tabRef: obj.tabRef.trim() } };
    }

    case "close_tab": {
      if (obj.tabRef !== undefined && (typeof obj.tabRef !== "string" || !obj.tabRef.trim())) {
        return { ok: false, error: "'close_tab' tabRef must be non-empty when provided" };
      }
      return { ok: true, action: { type: "close_tab", ...(obj.tabRef !== undefined ? { tabRef: obj.tabRef.trim() } : {}) } };
    }

    case "list_tabs":
      return { ok: true, action: { type: "list_tabs" } };

    case "click": {
      if (!isTarget(obj.target)) {
        return {
          ok: false,
          error: "'click' action requires a valid 'target' with css, role, name, or bbox",
        };
      }
      const piiMatch = findPiiInValue(obj.target);
      if (piiMatch) {
        return {
          ok: false,
          error: `Raw ${piiMatch} detected in click target`,
        };
      }
      return { ok: true, action: { type: "click", target: obj.target as Target } };
    }

    case "press_key": {
      if (!isTarget(obj.target)) return { ok: false, error: "'press_key' action requires a valid 'target'" };
      if (!(ALLOWED_KEYS as readonly string[]).includes(obj.key as string)) {
        return { ok: false, error: `Unsupported key: "${String(obj.key)}"` };
      }
      const keyPii = findPiiInValue(obj.target);
      if (keyPii) return { ok: false, error: `Raw ${keyPii} detected in press_key target` };
      return { ok: true, action: { type: "press_key", target: obj.target as Target, key: obj.key as any } };
    }

    case "focus":
    case "hover":
    case "clear":
    case "check":
    case "uncheck": {
      if (!isTarget(obj.target)) return { ok: false, error: `'${obj.type}' action requires a valid 'target'` };
      const targetPii = findPiiInValue(obj.target);
      if (targetPii) return { ok: false, error: `Raw ${targetPii} detected in action target` };
      return { ok: true, action: { type: obj.type, target: obj.target as Target } as AgentAction };
    }

    case "select_option": {
      if (!isTarget(obj.target)) return { ok: false, error: "'select_option' action requires a valid 'target'" };
      if (typeof obj.option !== "string" || !obj.option.trim()) {
        return { ok: false, error: "'select_option' action requires a non-empty 'option'" };
      }
      if (obj.option.length > 200) return { ok: false, error: "'select_option' option exceeds 200 characters" };
      const optionPii = findPiiInValue(obj.option) || findPiiInValue(obj.target);
      if (optionPii) return { ok: false, error: `Raw ${optionPii} detected in select_option` };
      return { ok: true, action: { type: "select_option", target: obj.target as Target, option: obj.option.trim() } };
    }

    case "wait_for": {
      const conditions = ["element", "text", "url", "gone", "stable"];
      if (typeof obj.condition !== "string" || !conditions.includes(obj.condition)) {
        return { ok: false, error: "'wait_for' action requires a supported condition" };
      }
      if (["element", "gone"].includes(obj.condition) && !isTarget(obj.target)) {
        return { ok: false, error: `'wait_for ${obj.condition}' requires a valid 'target'` };
      }
      if (obj.condition === "text" && (typeof obj.needle !== "string" || !obj.needle.trim())) {
        return { ok: false, error: "'wait_for text' requires a non-empty 'needle'" };
      }
      if (obj.condition === "url" && (typeof obj.urlPattern !== "string" || !obj.urlPattern.trim())) {
        return { ok: false, error: "'wait_for url' requires a non-empty 'urlPattern'" };
      }
      if (obj.timeoutMs !== undefined &&
          (typeof obj.timeoutMs !== "number" || !Number.isFinite(obj.timeoutMs) || obj.timeoutMs < 1 || obj.timeoutMs > 30000)) {
        return { ok: false, error: "'wait_for' timeoutMs must be between 1 and 30000" };
      }
      const waitPii = findPiiInValue(obj.target) || findPiiInValue(obj.needle) || findPiiInValue(obj.urlPattern);
      if (waitPii) return { ok: false, error: `Raw ${waitPii} detected in wait_for` };
      return {
        ok: true,
        action: {
          type: "wait_for",
          condition: obj.condition as any,
          ...(isTarget(obj.target) ? { target: obj.target as Target } : {}),
          ...(typeof obj.needle === "string" ? { needle: obj.needle.trim() } : {}),
          ...(typeof obj.urlPattern === "string" ? { urlPattern: obj.urlPattern.trim() } : {}),
          ...(typeof obj.timeoutMs === "number" ? { timeoutMs: obj.timeoutMs } : {}),
        },
      };
    }

    case "go_back":
    case "go_forward":
    case "reload":
      return { ok: true, action: { type: obj.type } as AgentAction };

    case "type": {
      if (!isTarget(obj.target)) {
        return {
          ok: false,
          error: "'type' action requires a valid 'target' with css, role, name, or bbox",
        };
      }

      if (typeof obj.placeholder !== "string" || obj.placeholder.trim().length === 0) {
        return { ok: false, error: "'type' action requires a non-empty 'placeholder' string" };
      }

      const trimmedPlaceholder = obj.placeholder.trim();

      // 1. Scan target locators for raw PII (same rule as the click branch —
      // a model echoing page data back in css/name must never pass)
      const targetPii = findPiiInValue(obj.target);
      if (targetPii) {
        return {
          ok: false,
          error: `Raw ${targetPii} detected in type target`,
        };
      }

      // 2. Scan for raw PII in placeholder
      const piiMatch = findPiiInValue(trimmedPlaceholder);
      if (piiMatch) {
        return {
          ok: false,
          error: `Raw ${piiMatch} detected in placeholder: "${obj.placeholder}". Only placeholder tokens allowed.`,
        };
      }

      // 3. Placeholder must be a category token (PAN_1) — or an exact phrase
      //    from the user's own goal, which the device re-verifies before
      //    typing (search boxes are not PII fields). GuardOptions carries the
      //    goal via sanitizedPackage.
      const isToken = PLACEHOLDER_TOKEN_REGEX.test(trimmedPlaceholder);
      if (!isToken) {
        const goal = goalText;
        const inGoal = goal.toLowerCase().includes(trimmedPlaceholder.toLowerCase());
        if (!inGoal) {
          return {
            ok: false,
            error: `Invalid placeholder format: "${obj.placeholder}". Must be a CATEGORY_N token from the allowlist or an exact phrase from the USER GOAL.`,
          };
        }
      }

      // 4. Enforce placeholder allowlist if available (tokens only — literal
      //    goal phrases are not in the placeholder map by definition)
      if (isToken && allowlist && !allowlist.has(trimmedPlaceholder)) {
        return {
          ok: false,
          error: `Placeholder "${trimmedPlaceholder}" does not exist in sanitized context allowlist [${Array.from(
            allowlist
          ).join(", ")}] — model hallucination`,
        };
      }

      return {
        ok: true,
        action: {
          type: "type",
          target: obj.target as Target,
          placeholder: trimmedPlaceholder,
        },
      };
    }

    case "scroll": {
      if (typeof obj.dy !== "number" || !Number.isFinite(obj.dy)) {
        return { ok: false, error: "'scroll' action requires a finite number 'dy'" };
      }
      return { ok: true, action: { type: "scroll", dy: obj.dy } };
    }

    case "search": {
      if (typeof obj.query !== "string" || obj.query.trim().length === 0) {
        return {
          ok: false,
          error: "'search' action requires a non-empty 'query' string",
        };
      }
      const trimmedQuery = obj.query.trim();
      if (trimmedQuery.length > 200) {
        return { ok: false, error: "'search' query exceeds 200 characters" };
      }
      // The query leaves this device for a third party (SerpAPI) — it must be
      // as PII-clean as anything else crossing the wire.
      const piiMatch = findPiiInValue(trimmedQuery);
      if (piiMatch) {
        return {
          ok: false,
          error: `Raw ${piiMatch} detected in search query — search terms must be PII-free`,
        };
      }
      return { ok: true, action: { type: "search", query: trimmedQuery } };
    }

    case "done": {
      if (typeof obj.reason !== "string" || obj.reason.trim().length === 0) {
        return { ok: false, error: "'done' action requires a non-empty 'reason' string" };
      }
      const piiMatch = findPiiInValue(obj.reason);
      if (piiMatch) {
        return {
          ok: false,
          error: `Raw ${piiMatch} detected in done reason: "${obj.reason}"`,
        };
      }
      const verify = obj.verify;
      if (verify !== undefined) {
        if (typeof verify !== "object" || verify === null || Array.isArray(verify)) {
          return { ok: false, error: "'done.verify' must be an object" };
        }
        const v = verify as Record<string, unknown>;
        const conditions = ["element", "text", "url", "gone"];
        if (typeof v.condition !== "string" || !conditions.includes(v.condition)) {
          return { ok: false, error: "'done.verify' requires a supported condition" };
        }
        if (["element", "gone"].includes(v.condition) && !isTarget(v.target)) {
          return { ok: false, error: `'done.verify ${v.condition}' requires a valid target` };
        }
        const targetPii = findPiiInValue(v.target);
        if (targetPii) return { ok: false, error: `Raw ${targetPii} detected in done verification target` };
        if (v.condition === "text" && (typeof v.needle !== "string" || !v.needle.trim())) {
          return { ok: false, error: "'done.verify text' requires a non-empty needle" };
        }
        if (v.condition === "url" && (typeof v.urlPattern !== "string" || !v.urlPattern.trim())) {
          return { ok: false, error: "'done.verify url' requires a non-empty urlPattern" };
        }
        if (v.timeoutMs !== undefined &&
            (typeof v.timeoutMs !== "number" || !Number.isFinite(v.timeoutMs) || v.timeoutMs < 1 || v.timeoutMs > 30000)) {
          return { ok: false, error: "'done.verify' timeoutMs must be between 1 and 30000" };
        }
        for (const value of [v.needle, v.urlPattern]) {
          if (typeof value === "string") {
            const valuePii = findPiiInValue(value);
            if (valuePii) return { ok: false, error: `Raw ${valuePii} detected in done verification` };
          }
        }
      }
      return {
        ok: true,
        action: { type: "done", reason: obj.reason.trim(), ...(verify !== undefined ? { verify } : {}) } as AgentAction,
      };
    }

    case "ask_human": {
      if (typeof obj.reason !== "string" || obj.reason.trim().length === 0) {
        return { ok: false, error: "'ask_human' action requires a non-empty 'reason' string" };
      }
      const piiMatch = findPiiInValue(obj.reason);
      if (piiMatch) {
        return {
          ok: false,
          error: `Raw ${piiMatch} detected in ask_human reason: "${obj.reason}"`,
        };
      }
      return { ok: true, action: { type: "ask_human", reason: obj.reason.trim() } };
    }

    default:
      return { ok: false, error: `Unknown action type: "${obj.type}"` };
  }
}

/**
 * Guards raw model output (string, JSON, object).
 * If validation fails, returns ok: false with fallbackAction: ask_human.
 */
export function guardModelOutput(
  rawOutput: unknown,
  options?: GuardOptions
): GuardResult {
  const allowlist = resolveAllowlist(options);

  try {
    const normalized = normalizeRawOutput(rawOutput);
    const result = validateActionWithGuard(
      normalized,
      allowlist,
      options?.sanitizedPackage?.goal ?? ""
    );
    if (!result.ok) {
      return {
        ok: false,
        error: result.error,
        // Redact: the fallback reason flows back into the next prompt via
        // lastStepResult — it must never carry the raw offending value.
        fallbackAction: {
          type: "ask_human",
          reason: redactPii(`Guard rejected model action: ${result.error}`),
        },
      };
    }
    return { ok: true, action: result.action };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    return {
      ok: false,
      error: msg,
      fallbackAction: {
        type: "ask_human",
        reason: redactPii(`Guard rejected model output: ${msg}`),
      },
    };
  }
}

/**
 * Guards an already-parsed AgentAction against allowlist, PII leaks, and schema constraints.
 */
export function guardAction(
  action: AgentAction,
  options?: GuardOptions
): GuardResult {
  const allowlist = resolveAllowlist(options);
  const result = validateActionWithGuard(
    action,
    allowlist,
    options?.sanitizedPackage?.goal ?? ""
  );
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      fallbackAction: {
        type: "ask_human",
        reason: redactPii(`Guard rejected action: ${result.error}`),
      },
    };
  }
  return { ok: true, action: result.action };
}
