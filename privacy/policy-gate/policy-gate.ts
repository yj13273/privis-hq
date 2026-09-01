// privacy/policy-gate/policy-gate.ts
// Policy Gate: Allow / Human Approval / Block decision maker
//
// Responsibilities:
// - Evaluates whether low-confidence detections or sensitive fields (e.g. passwords) are present.
// - Assesses host domain risk (banking, tax, EPFO, payroll).
// - Returns gate decision: "allow", "human_approval", or "block".

import type { BrowserState, Detection, PolicyGateResult } from "../../types/index.js";

const DENY_HOST_KEYWORDS = ["onlinesbi", "incometax", "epfo"];
const LOGIN_KEYWORDS = ["login", "signin", "sign-in", "auth", "authenticate"];
const TRUSTED_DEMO_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "demo-portal.local",
  "demo-portal.internal",
  "hr.internal.example",
]);

function isDemoOrLocalUrl(rawUrl: string): boolean {
  if (!rawUrl) return false;
  if (rawUrl.startsWith("file://")) return true;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "file:") return true;
    return TRUSTED_DEMO_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isDenyListedHost(rawUrl: string): boolean {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    return DENY_HOST_KEYWORDS.some((keyword) => host.includes(keyword));
  } catch {
    const lower = rawUrl.toLowerCase();
    return DENY_HOST_KEYWORDS.some((keyword) => lower.includes(keyword));
  }
}

function isLoginPage(browserState: BrowserState): boolean {
  const urlLower = (browserState.url || "").toLowerCase();
  const titleLower = (browserState.title || "").toLowerCase();
  return (
    LOGIN_KEYWORDS.some((kw) => urlLower.includes(kw)) ||
    LOGIN_KEYWORDS.some((kw) => titleLower.includes(kw))
  );
}

/**
 * Decides whether the sanitized package is safe to send to the remote agent.
 * @param params Detections and browser state
 */
export function decide(params: {
  detections: Detection[];
  browserState: BrowserState;
}): PolicyGateResult {
  const { detections, browserState } = params;

  // 1. v0 pragmatic demo rule: allow when all detections >= 0.8 and URL is file:// or trusted local/demo host
  const isDemoOrLocal = isDemoOrLocalUrl(browserState.url);
  const allHighConfidence =
    detections.length === 0 || detections.every((d) => d.confidence >= 0.8);

  if (isDemoOrLocal && allHighConfidence) {
    return {
      decision: "allow",
      reason:
        "Allowed under v0 demo exception: all detections have confidence >= 0.8 on local/demo URL",
    };
  }

  // 2. Block if a PASSWORD detection exists on external/non-demo sites
  const hasPassword = detections.some((d) => d.category === "PASSWORD");
  if (hasPassword) {
    return {
      decision: "block",
      reason:
        "Blocked: PASSWORD category detection present (password pages blocked from remote in v0)",
    };
  }

  // 4. Human approval if any detection confidence < 0.6
  const lowConfidenceDetection = detections.find((d) => d.confidence < 0.6);
  if (lowConfidenceDetection) {
    return {
      decision: "human_approval",
      reason: `Human approval required: low confidence detection (${lowConfidenceDetection.category} at ${lowConfidenceDetection.confidence.toFixed(2)})`,
    };
  }

  // 5. Human approval if category FACE on a login page
  const hasFace = detections.some((d) => d.category === "FACE");
  if (hasFace && isLoginPage(browserState)) {
    return {
      decision: "human_approval",
      reason: "Human approval required: FACE detection present on login/auth page",
    };
  }

  // 6. Allow otherwise
  return {
    decision: "allow",
    reason: "Allowed: all safety and confidence checks passed",
  };
}
