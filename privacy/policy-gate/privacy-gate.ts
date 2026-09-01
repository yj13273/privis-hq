import type { SanitizedPackage } from "../../types/index.js";

export interface PrivacyGateResult { allowed: boolean; reason: string; }

function outboundStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => outboundStrings(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => outboundStrings(item, out));
  return out;
}

/** Fail-closed validation immediately before network transmission. */
export function verifySanitizedPackage(pkg: unknown): PrivacyGateResult {
  if (!pkg || typeof pkg !== "object") return { allowed: false, reason: "missing sanitized package" };
  const value = pkg as Record<string, unknown>;
  if (value.sanitized !== true) return { allowed: false, reason: "package is not marked sanitized" };
  if ("dataUrl" in value || "rawScreenshot" in value || "rawOCR" in value || "originalDom" in value || "mapping" in value) return { allowed: false, reason: "raw capture field present" };
  if (typeof value.sanitizedScreenshot !== "string" || value.sanitizedScreenshot.length < 16) return { allowed: false, reason: "sanitized screenshot missing" };
  if (!value.sanitizedContext || typeof value.sanitizedContext !== "object") return { allowed: false, reason: "sanitized context missing" };
  const serializedStrings = outboundStrings(value.sanitizedContext).join("\n");
  if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|(?:\d[ -]*?){13,19}|\+?\d[\d\s().-]{8,}\d|secretpassword/i.test(serializedStrings)) return { allowed: false, reason: "sensitive value found in sanitized context" };
  return { allowed: true, reason: "sanitized package verified" };
}

export function assertSanitizedPackage(pkg: unknown): asserts pkg is SanitizedPackage {
  const result = verifySanitizedPackage(pkg);
  if (!result.allowed) throw new Error(`Privacy gate blocked request: ${result.reason}`);
}
