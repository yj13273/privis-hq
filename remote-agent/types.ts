// remote-agent/types.ts
// CBA-1: AgentAction contract + session types for Cloud Browser Agent
import type { ActionErrorCode } from "../types/index.js";

export interface ElementReference {
  snapshotVersion: number;
  elementId: string;
}

export interface Target {
  css?: string;
  role?: string;
  name?: string;
  bbox?: [number, number, number, number];
  ref?: ElementReference;
}

export interface NavigateAction {
  type: "navigate";
  url: string;
}

export interface ClickAction {
  type: "click";
  target: Target;
}

export interface TypeAction {
  type: "type";
  target: Target;
  placeholder: string; // e.g. "PAN_1", "EMAIL_1", "AADHAAR_1", "NAME_1", "AMOUNT_1", "PHONE_1", "SSN_1", "CARD_1"
}

export const ALLOWED_KEYS = [
  "Enter",
  "Tab",
  "Shift+Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Backspace",
  "Delete",
  "Control+A",
] as const;

export type AllowedKey = (typeof ALLOWED_KEYS)[number];

export interface PressKeyAction {
  type: "press_key";
  target: Target;
  key: AllowedKey;
}

export interface TargetAction {
  type: "focus" | "hover" | "clear" | "check" | "uncheck";
  target: Target;
}

export interface SelectOptionAction {
  type: "select_option";
  target: Target;
  option: string;
}

export interface WaitForAction {
  type: "wait_for";
  condition: "element" | "text" | "url" | "gone" | "stable";
  target?: Target;
  needle?: string;
  urlPattern?: string;
  timeoutMs?: number;
}

export interface HistoryAction {
  type: "go_back" | "go_forward" | "reload";
}

export interface ScrollAction {
  type: "scroll";
  dy: number;
}

/**
 * Destination discovery: the model asks the SERVER to run a web search
 * (SerpAPI) and answers with a navigate action. Never reaches the extension
 * — runStep fails closed if one leaks through.
 */
export interface SearchAction {
  type: "search";
  query: string;
}

export interface DoneVerification {
  condition: "element" | "text" | "url" | "gone";
  target?: Target;
  needle?: string;
  urlPattern?: string;
  timeoutMs?: number;
}

export interface DoneAction {
  type: "done";
  reason: string;
  verify?: DoneVerification;
}

export interface AskHumanAction {
  type: "ask_human";
  reason: string;
}

export type AgentAction =
  | NavigateAction
  | ClickAction
  | TypeAction
  | ScrollAction
  | PressKeyAction
  | TargetAction
  | SelectOptionAction
  | WaitForAction
  | HistoryAction
  | SearchAction
  | DoneAction
  | AskHumanAction;

export type AgentActionType = AgentAction["type"];

export type SessionStatus = "idle" | "running" | "waiting_human" | "done" | "error" | "blocked";

export interface SessionStep {
  step: number;
  url: string;
  action: AgentAction;
  result?: { ok: boolean; error?: string; code?: ActionErrorCode };
  timestamp: number;
}

export interface AgentSession {
  sessionId: string;
  tabId: number;
  goal: string;
  step?: number;
  maxSteps?: number;
  status: SessionStatus;
  gateDecision?: "allow" | "human_approval" | "block";
  history: SessionStep[];
  lastAction?: AgentAction;
  /** Redacted state/action fingerprints used to stop blind identical retries. */
  lastFailureFingerprint?: string;
  lastFailureAction?: string;
  /** Exact redacted-only package view dispatched to the remote planner. */
  outboundPayload?: {
    sanitizedScreenshot: string;
    elements: Array<{
      tag: string;
      type: string | null;
      role: string | null;
      text: string;
    }>;
    placeholders: string[];
    url: string;
    model: "chatgpt" | "gemini";
  };
  error?: string;
}

/**
 * Comprehensive PII pattern registry covering >90% of real-world PII edge cases:
 * - National & Government IDs (PAN, Aadhaar, US SSN, UK NINO, Passports)
 * - Financial & Payment (Credit/Debit Cards, IBAN, IFSC, UPI VPAs, Currency Amounts)
 * - Contact & Identity (Emails, Phone numbers with global formats, IP addresses, Dates of Birth)
 * - Authentication & Secrets (JWT tokens, API keys, Bearer credentials)
 */
export const PII_PATTERNS: { name: string; re: RegExp }[] = [
  // Government / National IDs
  { name: "PAN", re: /\b[a-z]{5}[0-9]{4}[a-z]\b/i },
  { name: "AADHAAR", re: /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/ },
  { name: "US_SSN", re: /\b(?!000|666|9\d{2})\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4}\b/ },
  { name: "UK_NINO", re: /\b(?:[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]|QQ)\s?[0-9]{2}\s?[0-9]{2}\s?[0-9]{2}\s?[A-D]\b/i },
  { name: "PASSPORT", re: /\b[A-Z][0-9]{7,8}\b/ },

  // Financial & Banking
  {
    name: "CREDIT_CARD",
    re: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|2[2-7][0-9]{14}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12}|60[0-9]{14}|65[0-9]{14}|81[0-9]{14}|82[0-9]{14}|508[0-9]{13}|35[0-9]{14})(?:[\s-]?[0-9]{4})*\b|\b(?:\d{4}[ -]?){3}\d{4}\b|\b\d{4}[ -]?\d{6}[ -]?\d{5}\b/,
  },
  { name: "IBAN", re: /\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}([A-Z0-9]?){0,16}\b/i },
  { name: "IFSC", re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/i },
  {
    name: "UPI_VPA",
    re: /\b[a-zA-Z0-9._-]+@(okaxis|okhdfcbank|okicici|oksbi|paytm|ybl|ibl|upi|axl|apl|allbank|albk|aubank|axisbank|barodampay|cnrb|csbpay|dbs|dcbbank|federal|hdfcbank|hsbc|icici|idbi|idfcbank|indus|iob|kbl|kvb|kotak|pnb|rbl|sc|sib|synb|tjsb|uco|unionbank|vijb|yesbank)\b/i,
  },
  {
    name: "CURRENCY_AMOUNT",
    re: /(?:\b(?:USD|EUR|GBP|INR|CAD|AUD)\s?[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?\b|[$€£₹¥]\s?[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?\b|\b[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?\s?(?:USD|EUR|GBP|INR|₹|Rs\.?)\b)/i,
  },

  // Contact & Personal
  { name: "EMAIL", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  {
    name: "PHONE",
    re: /(?:\b\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b|\+\d{1,3}[-.\s]?\(?\d{2,4}\)?[-.\s]?\d{3,5}[-.\s]?\d{3,5}\b)/,
  },
  {
    name: "IPV4",
    re: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/,
  },
  {
    name: "DOB_DATE",
    re: /\b(?:0?[1-9]|[12][0-9]|3[01])[-/.](?:0?[1-9]|1[012])[-/.](?:19|20)\d\d\b|\b(?:19|20)\d\d[-/.](?:0?[1-9]|1[012])[-/.](?:0?[1-9]|[12][0-9]|3[01])\b/,
  },

  // Auth & Secrets
  { name: "JWT", re: /\beyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*\b/ },
  {
    name: "API_KEY",
    re: /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{36,255}|sk-[a-zA-Z0-9]{32,}|Bearer\s+[A-Za-z0-9._~+/-]+=*)\b/,
  },
];

const FORBIDDEN_SCHEMES = [
  "javascript:",
  "data:",
  "file:",
  "vbscript:",
  "chrome:",
  "chrome-extension:",
  "about:",
];

/**
 * Format for legitimate privacy placeholder tokens (e.g., PAN_1, EMAIL_1, CUSTOM_TOKEN_2).
 */
export const PLACEHOLDER_TOKEN_REGEX = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_\d+$/;

/**
 * Validates a Target object.
 * Must be a non-null object with at least one locator or valid bbox field.
 */
export function isTarget(target: unknown): target is Target {
  if (typeof target !== "object" || target === null || Array.isArray(target)) {
    return false;
  }
  const t = target as Record<string, unknown>;
  const hasCss = typeof t.css === "string" && t.css.trim().length > 0;
  const hasRole = typeof t.role === "string" && t.role.trim().length > 0;
  const hasName = typeof t.name === "string" && t.name.trim().length > 0;
  const hasBbox =
    Array.isArray(t.bbox) &&
    t.bbox.length === 4 &&
    t.bbox.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    (t.bbox as number[])[2] >= 0 &&
    (t.bbox as number[])[3] >= 0;
  const ref = t.ref as Record<string, unknown> | undefined;
  const hasRef = typeof ref === "object" && ref !== null &&
    Number.isInteger(ref.snapshotVersion) &&
    (ref.snapshotVersion as number) > 0 &&
    typeof ref.elementId === "string" &&
    ref.elementId.trim().length > 0;

  return hasCss || hasRole || hasName || hasBbox || hasRef;
}

/**
 * Validates whether an unknown value conforms to the AgentAction schema.
 * Rejects raw values, dangerous URL schemes, or malformed targets.
 */
export function validateAgentAction(
  input: unknown
): { ok: true; action: AgentAction } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Action must be a non-null object" };
  }

  const obj = input as Record<string, unknown>;

  if (typeof obj.type !== "string") {
    return { ok: false, error: "Missing or invalid 'type' property in action" };
  }

  switch (obj.type) {
    case "navigate": {
      if (typeof obj.url !== "string" || obj.url.trim().length === 0) {
        return { ok: false, error: "'navigate' action requires a non-empty 'url' string" };
      }
      const trimmedUrl = obj.url.trim().toLowerCase();
      for (const scheme of FORBIDDEN_SCHEMES) {
        if (trimmedUrl.startsWith(scheme)) {
          return { ok: false, error: `Forbidden URL scheme in navigate action: "${obj.url}"` };
        }
      }
      return { ok: true, action: { type: "navigate", url: obj.url.trim() } };
    }

    case "click": {
      if (!isTarget(obj.target)) {
        return {
          ok: false,
          error: "'click' action requires a valid 'target' with css, role, name, or bbox",
        };
      }
      return { ok: true, action: { type: "click", target: obj.target } };
    }

    case "press_key": {
      if (!isTarget(obj.target)) {
        return { ok: false, error: "'press_key' action requires a valid 'target'" };
      }
      if (!(ALLOWED_KEYS as readonly string[]).includes(obj.key as string)) {
        return { ok: false, error: `Unsupported key: "${String(obj.key)}"` };
      }
      return { ok: true, action: { type: "press_key", target: obj.target, key: obj.key as AllowedKey } };
    }

    case "focus":
    case "hover":
    case "clear":
    case "check":
    case "uncheck": {
      if (!isTarget(obj.target)) {
        return { ok: false, error: `'${obj.type}' action requires a valid 'target'` };
      }
      return { ok: true, action: { type: obj.type, target: obj.target } as TargetAction };
    }

    case "select_option": {
      if (!isTarget(obj.target)) {
        return { ok: false, error: "'select_option' action requires a valid 'target'" };
      }
      if (typeof obj.option !== "string" || !obj.option.trim()) {
        return { ok: false, error: "'select_option' action requires a non-empty 'option'" };
      }
      if (obj.option.length > 200) {
        return { ok: false, error: "'select_option' option exceeds 200 characters" };
      }
      for (const { name, re } of PII_PATTERNS) {
        if (re.test(obj.option)) return { ok: false, error: `Raw ${name} detected in option` };
      }
      return { ok: true, action: { type: "select_option", target: obj.target, option: obj.option.trim() } };
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
      const waitStrings = [obj.needle, obj.urlPattern].filter((v): v is string => typeof v === "string");
      for (const value of waitStrings) {
        for (const { name, re } of PII_PATTERNS) {
          if (re.test(value)) return { ok: false, error: `Raw ${name} detected in wait condition` };
        }
      }
      return {
        ok: true,
        action: {
          type: "wait_for",
          condition: obj.condition as WaitForAction["condition"],
          ...(isTarget(obj.target) ? { target: obj.target } : {}),
          ...(typeof obj.needle === "string" ? { needle: obj.needle.trim() } : {}),
          ...(typeof obj.urlPattern === "string" ? { urlPattern: obj.urlPattern.trim() } : {}),
          ...(typeof obj.timeoutMs === "number" ? { timeoutMs: obj.timeoutMs } : {}),
        },
      };
    }

    case "go_back":
    case "go_forward":
    case "reload":
      return { ok: true, action: { type: obj.type } as HistoryAction };

    case "type": {
      for (const rawKey of ["value", "text", "input", "val", "content"]) {
        if (rawKey in obj) {
          return {
            ok: false,
            error: `'type' action must not contain raw field '${rawKey}' — pass placeholder only (e.g. 'PAN_1', 'EMAIL_1')`,
          };
        }
      }
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

      // Scan against the comprehensive PII registry
      for (const { name, re } of PII_PATTERNS) {
        if (re.test(trimmedPlaceholder)) {
          return {
            ok: false,
            error: `Raw ${name} detected in placeholder: "${obj.placeholder}". Only placeholder tokens are allowed.`,
          };
        }
      }

      // Category-token format is NOT enforced here: a literal phrase from the
      // user's own goal is legal (see guard.ts 'type' — token-or-goal-substring
      // — and the on-device re-check in executor/agent-action.ts, which is the
      // real trust boundary). Keep a size cap so no prompt-scale blob arrives.
      if (trimmedPlaceholder.length > 300) {
        return { ok: false, error: "'placeholder' exceeds 300 characters" };
      }

      return {
        ok: true,
        action: {
          type: "type",
          target: obj.target,
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
        return { ok: false, error: "'search' action requires a non-empty 'query' string" };
      }
      if (obj.query.trim().length > 200) {
        return { ok: false, error: "'search' query exceeds 200 characters" };
      }
      return { ok: true, action: { type: "search", query: obj.query.trim() } };
    }

    case "done": {
      if (typeof obj.reason !== "string" || obj.reason.trim().length === 0) {
        return { ok: false, error: "'done' action requires a non-empty 'reason' string" };
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
        const strings = [v.needle, v.urlPattern].filter((value): value is string => typeof value === "string");
        for (const value of strings) {
          for (const { name, re } of PII_PATTERNS) {
            if (re.test(value)) return { ok: false, error: `Raw ${name} detected in done verification` };
          }
        }
      }
      return {
        ok: true,
        action: {
          type: "done",
          reason: obj.reason.trim(),
          ...(verify !== undefined ? { verify: verify as DoneVerification } : {}),
        },
      };
    }

    case "ask_human": {
      if (typeof obj.reason !== "string" || obj.reason.trim().length === 0) {
        return { ok: false, error: "'ask_human' action requires a non-empty 'reason' string" };
      }
      return { ok: true, action: { type: "ask_human", reason: obj.reason.trim() } };
    }

    default:
      return { ok: false, error: `Unknown action type: "${obj.type}"` };
  }
}

/**
 * Type guard for AgentAction.
 */
export function isAgentAction(input: unknown): input is AgentAction {
  return validateAgentAction(input).ok;
}

/**
 * Unwraps markdown code fences or container wrappers (like `{ action: ... }`) if present.
 */
function normalizePayload(input: unknown): unknown {
  let val = input;
  if (typeof val === "string") {
    let clean = val.trim();
    if (clean.startsWith("```")) {
      clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    }
    try {
      val = JSON.parse(clean);
    } catch (err) {
      throw new Error(`Invalid JSON for AgentAction: ${(err as Error).message}`);
    }
  }

  if (typeof val === "object" && val !== null && !Array.isArray(val)) {
    const record = val as Record<string, unknown>;
    if ("action" in record && typeof record.action === "object" && record.action !== null) {
      val = record.action;
    } else if (
      "agent_action" in record &&
      typeof record.agent_action === "object" &&
      record.agent_action !== null
    ) {
      val = record.agent_action;
    }
  }

  return val;
}

/**
 * Parses a JSON string or raw object into a validated AgentAction.
 * Throws a descriptive Error on validation failure, dangerous input, or raw PII detection.
 */
export function parseAgentAction(input: unknown): AgentAction {
  const normalized = normalizePayload(input);
  const result = validateAgentAction(normalized);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.action;
}
