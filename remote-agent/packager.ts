// remote-agent/packager.ts
// CBA-3 Packager: Assembles model prompt from sanitized context,
// enforces placeholder isolation, attaches last step result, and exports allowlist.

import type { PlannerContext, SanitizedPackage, SanitizedContext } from "../types/index.js";
import type { AgentAction } from "./types.js";
import { assertSanitizedPackage } from "./router.js";
import { getPlaceholderAllowlistFromContext, redactPii } from "./guard.js";
import systemPromptText from "./prompt.md";

export interface LastStepResult {
  action?: AgentAction;
  result?: { ok: boolean; error?: string; detail?: string };
}

export interface PackagedPrompt {
  systemPrompt: string;
  userPrompt: string;
  allowlist: Set<string>;
  screenshot?: string;
}

/**
 * The runtime system prompt — loaded verbatim from prompt.md at build time
 * (single source of truth; editing prompt.md changes model behavior).
 */
export const SYSTEM_PROMPT: string = systemPromptText;

/**
 * Returns the system prompt text for PRIVIS Remote Agent.
 */
export function buildSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

/**
 * Extracts all valid placeholder tokens present in the sanitized context.
 */
export function extractPlaceholderAllowlist(context: SanitizedContext): Set<string> {
  return getPlaceholderAllowlistFromContext(context);
}

/**
 * Formats the last step action & result into a human-readable summary line for the model.
 * Every fragment is PII-redacted: executor errors and echoed actions can carry raw page
 * data, and this line goes straight into the next LLM prompt.
 */
function formatLastStepResult(lastStep?: LastStepResult): string | null {
  if (!lastStep || (!lastStep.action && !lastStep.result)) {
    return null;
  }

  const parts: string[] = [];
  if (lastStep.action) {
    parts.push(redactPii(`Action: ${JSON.stringify(lastStep.action)}`));
  }
  if (lastStep.result) {
    if (lastStep.result.ok) {
      parts.push("Result: OK");
    } else {
      parts.push(`Result: FAILED (${redactPii(lastStep.result.error || "unknown error")})`);
    }
    if (lastStep.result.detail) parts.push(`Detail: ${redactPii(lastStep.result.detail)}`);
  }

  return parts.length > 0 ? parts.join(" -> ") : null;
}

function formatPlannerContext(context?: PlannerContext): string | null {
  if (!context) return null;

  const lines = [
    `STEP: ${context.step}/${context.maxSteps}`,
    `PHASE: ${context.phase}`,
    `PROGRESS: ${redactPii(context.progress)}`,
  ];
  const lastStep = formatLastStepResult(context.lastStep);
  if (lastStep) lines.push(`LAST STEP RESULT: ${lastStep}`);
  if (context.recentHistory.length > 0) {
    lines.push(
      `RECENT HISTORY:\n${context.recentHistory
        .map((step, index) => `${index + 1}. ${formatLastStepResult(step)}`)
        .join("\n")}`
    );
  }
  return lines.join("\n");
}

/**
 * Builds the user prompt summarizing goal, browser state, last step result,
 * placeholder allowlist, and sanitized DOM elements.
 * Only accepts a validated SanitizedPackage — the sanitization boundary is
 * asserted here so no caller can format raw context into a prompt.
 */
export function buildUserPrompt(
  pkg: SanitizedPackage,
  lastStepResult?: LastStepResult
): string {
  // Boundary: refuse raw/unstamped packages before anything is serialized.
  assertSanitizedPackage(pkg);

  const elementsSummary = (pkg.sanitizedContext.elements || [])
    .map((el, idx) => {
      const parts = [`[${idx}] <${el.tag}`];
      if (el.element_id) parts.push(`id="${el.element_id}"`);
      if (el.type) parts.push(`type="${el.type}"`);
      if (el.role) parts.push(`role="${el.role}"`);
      if (el.snapshotVersion !== undefined) {
        parts.push(`ref={snapshotVersion:${el.snapshotVersion},documentId:"${el.documentId ?? ""}",frameId:${el.frameId ?? 0},elementId:"${el.element_id}"}`);
      }
      if (el.parentElementId) parts.push(`parentElementId="${el.parentElementId}"`);
      for (const [key, value] of [
        ["disabled", el.disabled], ["checked", el.checked], ["selected", el.selected],
        ["expanded", el.expanded], ["focused", el.focused],
      ] as const) {
        if (value !== undefined) parts.push(`${key}=${value}`);
      }
      // `label` is intentionally omitted: the sanitizer only swaps `text`, so a
      // label can still carry raw page/user data (same boundary the extension
      // service-worker applies before dispatching to the remote agent).
      parts.push(`>`);
      if (el.text) parts.push(`text="${el.text}"`);
      if (el.bbox) parts.push(`bbox=[${el.bbox.join(",")}]`);
      return parts.join(" ");
    })
    .join("\n");

  const allowlist = extractPlaceholderAllowlist(pkg.sanitizedContext);
  const allowlistSummary =
    allowlist.size > 0 ? Array.from(allowlist).join(", ") : "(none)";

  const lines: string[] = [
    `USER GOAL: ${pkg.goal}`,
    `PAGE URL: ${pkg.sanitizedContext.browserState.url}`,
    `PAGE TITLE: ${pkg.sanitizedContext.browserState.title}`,
    `VIEWPORT: ${pkg.sanitizedContext.browserState.viewport.w}x${pkg.sanitizedContext.browserState.viewport.h}`,
  ];

  const formattedLastStep = formatLastStepResult(lastStepResult);
  if (formattedLastStep) {
    lines.push(`LAST STEP RESULT: ${formattedLastStep}`);
  }

  const formattedPlannerContext = formatPlannerContext(pkg.plannerContext);
  if (formattedPlannerContext) {
    lines.push(`SESSION CONTEXT:\n${formattedPlannerContext}`);
  }

  lines.push(`AVAILABLE PLACEHOLDERS: [${allowlistSummary}]`);
  lines.push(`\nSANITIZED PAGE ELEMENTS:`);
  lines.push(elementsSummary || "(no interactive elements detected)");
  lines.push(
    `\nDetermine the single next AgentAction to take towards the goal. Output raw JSON only.`
  );

  return lines.join("\n");
}

/**
 * Validates the SanitizedPackage boundary and packages the prompts, placeholder allowlist,
 * and optional screenshot ready for the LLM client.
 */
export function packagePrompt(
  pkg: SanitizedPackage,
  options?: { lastStepResult?: LastStepResult }
): PackagedPrompt {
  const allowlist = extractPlaceholderAllowlist(pkg.sanitizedContext);
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(pkg, options?.lastStepResult); // also re-asserts the boundary

  return {
    systemPrompt,
    userPrompt,
    allowlist,
    screenshot: pkg.sanitizedScreenshot,
  };
}
