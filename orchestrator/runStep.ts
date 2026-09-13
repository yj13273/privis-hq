// orchestrator/runStep.ts
// CBA-6: the multi-page session loop. After each action:
// capture → Engine → Sanitizer → Gate → Remote Agent → Executor → recapture.
// Max 8 steps; reaching the cap without `done` escalates to ask_human.
//
//   while step < 8:
//     capture → sanitize → gate
//     if not Allow: stop, tell chat
//     action = remoteAgent.plan(...)
//     if done: stop
//     executor.run(action)
//
// Session state (tabId, step, last action, goal) stays on the device — see
// orchestrator/session.ts. This module previously lived as a one-shot runStep
// in background/service-worker.ts: a single click/type ended the session.
// Now every executed action recaptures, so form filling (type → type → click
// → next page) runs as one continuous session.

import type {
  Action,
  ActionResult,
  AgentAction,
  AgentSession,
  CapturePackage,
  CaptureResponseMessage,
  ElementMeta,
  PlannerContext,
  StepResult,
  DoneVerification,
} from "../types/index.js";
import { takeScreenshot } from "../utils/screenshot.js";
import { sendToContent } from "../utils/messaging.js";
import {
  detectSensitive,
  applyPlaceholders,
} from "../privacy/sanitizer/structural-redact.js";
import { redactVisual } from "../privacy/sanitizer/visual-redact.js";
import { decide } from "../privacy/policy-gate/policy-gate.js";
import { loadModelSettings } from "../extension/src/settings/models.js";
import { queryServer, serverOptionsFromSettings } from "../remote-agent/client-server.js";
import { agentActionToExecutorActions } from "../executor/agent-action.js";
import { redactPii } from "../remote-agent/guard.js";
import { applyActions } from "../executor/local-executor.js";
import {
  navigateTab,
  waitForTabTransition,
  openTab,
  switchTab,
  closeTab,
  listTabs,
  tabIdForRef,
} from "../executor/navigate.js";
import { runVisionPath } from "../privacy/engine/vision/face-pipeline.js";
import {
  notifySessionUpdate,
  runSessionLoop,
  startSession,
  waitForHumanDecision,
  tryBeginLoop,
  endLoop,
  type Outcome,
} from "./session.js";
import {
  computeRequestDigest,
  logTransparencyEntry,
} from "./transparency-log.js";

/**
 * Snapshot the content-script DOM package for a tab, then run DOM-path
 * detections (detectSensitive) on the elements.
 * @param tabId Target tab ID
 */
// Snapshot the content-script DOM package for a tab.
async function frameIds(tabId: number): Promise<number[]> {
  try {
    const frames = await chrome.webNavigation?.getAllFrames?.({ tabId });
    const ids = frames?.map((frame) => frame.frameId).filter((id): id is number => typeof id === "number");
    return ids?.length ? ids : [0];
  } catch {
    return [0];
  }
}

function domPackage(tabId: number, frameId = 0): Promise<CaptureResponseMessage> {
  return sendToContent<CaptureResponseMessage>(tabId, { type: "capture.request", frameId }, frameId);
}

async function domPackages(tabId: number): Promise<CaptureResponseMessage[]> {
  const packages = await Promise.all((await frameIds(tabId)).map((frameId) => domPackage(tabId, frameId)));
  return packages.filter((pkg) => pkg.payload.elements.length > 0 || pkg.payload.frameId === 0);
}

// Cheap, deterministic fingerprint of the DOM package. Element ids are stable
// across extractions (the content script keys them by DOM node), so equality
// here means the page did not change between snapshots.
function packageFingerprint(packages: CaptureResponseMessage[]): string {
  return JSON.stringify(packages.map(({ payload }) => ({
    browserState: payload.browserState,
    elements: payload.elements.map(({ snapshotVersion: _snapshotVersion, ...element }) => element),
  })));
}

export async function capturePackage(tabId: number): Promise<CapturePackage> {
  const MAX_TRIES = 3;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    // Snapshot the DOM first, capture the screenshot of that same state, then
    // re-snapshot the DOM and require it to be unchanged. This guarantees the
    // detections always describe the pixels we redact — never detections from
    // one page state applied to another state's screenshot.
    const before = await domPackages(tabId);
    const { dataUrl } = await takeScreenshot(tabId);
    const after = await domPackages(tabId);
    if (packageFingerprint(before) === packageFingerprint(after)) {
      const primary = before.find((pkg) => pkg.payload.frameId === 0) ?? before[0];
      const elements = before.flatMap((pkg) => pkg.payload.elements);
      if (!primary) throw new Error("capturePackage: top-level frame is unavailable");
      return {
        tabId,
        dataUrl,
        elements,
        detections: detectSensitive(elements),
        browserState: primary.payload.browserState,
        snapshotVersion: primary.payload.snapshotVersion,
        documentId: primary.payload.documentId,
      };
    }
  }
  throw new Error(
    "capturePackage: page state kept changing between DOM snapshot and screenshot"
  );
}

function buildPlannerContext(session: AgentSession): PlannerContext {
  const recentHistory = session.history.slice(-6).map((step) => ({
    action: step.action,
    result: step.result
      ? {
          ok: step.result.ok,
          ...(step.result.code ? { code: step.result.code } : {}),
          ...(step.result.error ? { error: redactPii(step.result.error) } : {}),
          ...(step.result.detail ? { detail: redactPii(step.result.detail) } : {}),
        }
      : undefined,
  }));
  const completed = session.history.filter((step) => step.result?.ok).length;
  const failed = session.history.filter((step) => step.result && !step.result.ok).length;

  return {
    step: session.history.length,
    maxSteps: session.maxSteps ?? 0,
    phase: session.goal.includes("[Human follow-up]:")
      ? "human_follow_up"
      : session.history.length === 0
        ? "initial"
        : "continuing",
    progress: `${completed} completed action(s); ${failed} failed action(s); current page state was freshly captured`,
    lastStep: recentHistory.at(-1),
    recentHistory,
  };
}

// In-memory step cache for the HUD
const lastLiveSteps: Array<Record<string, unknown>> = [];

export function getLiveSteps(): Array<Record<string, unknown>> {
  return lastLiveSteps;
}

// Helper to broadcast step updates with rich data to the popup HUD
function broadcastHudStep(step: number, data: Record<string, unknown>) {
  const payload = { type: "hud.liveStep", step, ...data };
  if (step === 1) lastLiveSteps.length = 0;
  lastLiveSteps.push(payload);
  try {
    // HUD popup might be closed; safe to ignore.
    void chrome.runtime.sendMessage(payload).catch(() => {});
  } catch {
    // Ignore if no receiver
  }
}

/**
 * Let a just-executed action land before the recapture: poll until the tab
 * reports status "complete" (a click on Submit navigates to page B). Bounded
 * and non-fatal — capturePackage's before/after fingerprint check is the real
 * guard against a mid-transition snapshot.
 */
async function waitForTabSettled(tabId: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") return;
    } catch {
      return; // tab closed — capturePackage will surface the real error
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

function sanitizedStateFingerprint(pkg: CapturePackage, elements: ElementMeta[]): string {
  return JSON.stringify({
    url: pkg.browserState.url,
    elements: elements.map(({ element_id, tag, type, role, label, text, bbox }) => ({
      element_id, tag, type, role, label, text, bbox,
    })),
  });
}

function verificationActions(
  verify: DoneVerification,
  sanitized: ElementMeta[],
  map: Record<string, string>,
  goal: string
): Action[] {
  return agentActionToExecutorActions(
    {
      type: "wait_for",
      condition: verify.condition,
      ...(verify.target ? { target: verify.target } : {}),
      ...(verify.needle ? { needle: verify.needle } : {}),
      ...(verify.urlPattern ? { urlPattern: verify.urlPattern } : {}),
      timeoutMs: verify.timeoutMs,
    },
    sanitized,
    map,
    goal
  );
}

/**
 * Execute a full step of the privacy-preserving agent loop.
 * @param tabId Target tab ID
 * @param goal Human prompt or task instruction
 */
export async function runStep(tabId: number, goal: string): Promise<StepResult> {
  // One loop per tab at a time: a toolbar click while a chat goal is running
  // must not start a second loop interleaving the same session history.
  if (!tryBeginLoop(tabId)) {
    return { decision: "allow", reason: "A session loop is already running on this tab." };
  }
  try {
    const session = startSession(tabId, goal);
    notifySessionUpdate(session);
    // CBA-6 loop: keep recapturing after each action until the agent says done,
    // the gate stops us, or the step cap is hit. Infra errors (capture, vision,
    // remote) reject the run — the session is already marked "error" + notified.
    return await runSessionLoop(session, (s) => runOneStep(s));
  } finally {
    endLoop(tabId);
  }
}

/**
 * One pipeline pass: capture → Engine → Sanitizer → Gate → Remote Agent →
 * Executor. Throws on capture/vision/remote failure (fail-closed, session
 * marked "error"); otherwise returns this pass's StepResult with `stop` set
 * when the session loop must end.
 */
async function runOneStep(session: AgentSession): Promise<Outcome> {
  const { tabId, goal } = session;
  let pkg: CapturePackage;
  try {
    pkg = await capturePackage(tabId);
  } catch (err: unknown) {
    session.status = "error";
    session.error = err instanceof Error ? err.message : String(err);
    notifySessionUpdate(session);
    throw err;
  }

  // M6-D vision path: browser-local YuNet FACE inference on the SAME in-memory
  // screenshot (no extra capture), fused with the DOM detections through the
  // M4 rules (privacy/engine/fuse.ts). FAIL-CLOSED: any decode/model/inference
  // error rejects this step before the gate — never an empty detection list
  // with an unsanitized screenshot heading to the remote agent.
  try {
    pkg.detections = await runVisionPath({
      dataUrl: pkg.dataUrl,
      elements: pkg.elements,
      domDetections: pkg.detections,
      viewport: pkg.browserState.viewport,
    });
  } catch (err: unknown) {
    session.status = "error";
    session.error = err instanceof Error ? err.message : String(err);
    notifySessionUpdate(session);
    throw err;
  }

  broadcastHudStep(1, {
    rawScreenshot: pkg.dataUrl,
    elementCount: pkg.elements.length,
    viewport: pkg.browserState.viewport,
  });

  // Vision Engine Detections
  broadcastHudStep(2, {
    detections: pkg.detections,
  });

  // Sanitizer: structural placeholders + in-memory visual redaction.
  const { sanitized, map } = applyPlaceholders(pkg.elements, pkg.detections);
  const currentStateFingerprint = sanitizedStateFingerprint(pkg, sanitized);
  const sanitizedScreenshot = await redactVisual(
    pkg.dataUrl,
    pkg.detections,
    pkg.browserState.viewport
  );
  // Real value -> placeholder pairs, so the HUD can show the swap happening.
  // The map itself never leaves this device; only placeholders go to the agent.
  const swaps = sanitized
    .filter((el) => typeof map[el.element_id] === "string")
    .map((el) => ({ real: map[el.element_id], placeholder: el.text }));
  broadcastHudStep(3, {
    sanitizedScreenshot,
    rawScreenshot: pkg.dataUrl,
    swaps,
    detectionsCount: pkg.detections.length,
  });

  // Policy Gate: never call the remote unless the package is allowed out.
  const gate = decide({ detections: pkg.detections, browserState: pkg.browserState });
  session.gateDecision = gate.decision;
  broadcastHudStep(4, {
    decision: gate.decision,
    reason: gate.reason,
  });
  notifySessionUpdate(session, gate);

  if (gate.decision === "block") {
    session.status = "blocked";
    session.error = gate.reason;
    notifySessionUpdate(session, gate);

    // CBA-11: Log blocked step to transparency audit store with response: null
    const remoteElements: ElementMeta[] = sanitized.map((el) => ({ ...el, label: null }));
    const settings = await loadModelSettings();
    const refusedPkg = {
      goal,
      sanitizedScreenshot,
      sanitizedContext: { elements: remoteElements, browserState: pkg.browserState },
      redacted: true as const,
    };
    const requestDigest = await computeRequestDigest(refusedPkg);
    await logTransparencyEntry({
      sessionId: session.sessionId,
      tabIdHint: tabId,
      goal,
      step: session.history.length + 1,
      timestamp: Date.now(),
      model: settings.model,
      request: refusedPkg,
      requestDigest,
      response: null,
      gate: { decision: gate.decision, reason: gate.reason },
      error: gate.reason,
    });

    return { decision: gate.decision, reason: gate.reason, stop: true };
  }

  if (gate.decision === "human_approval") {
    session.status = "waiting_human";
    session.error = gate.reason;
    notifySessionUpdate(session, gate);
    const approved = await waitForHumanDecision(session.sessionId);
    if (!approved) {
      session.status = "blocked";
      session.error = "Human rejected action";
      notifySessionUpdate(session, gate);

      // CBA-11: Log rejected step to transparency audit store
      const remoteElements: ElementMeta[] = sanitized.map((el) => ({ ...el, label: null }));
      const settings = await loadModelSettings();
      const refusedPkg = {
        goal,
        sanitizedScreenshot,
        sanitizedContext: { elements: remoteElements, browserState: pkg.browserState },
        redacted: true as const,
      };
      const requestDigest = await computeRequestDigest(refusedPkg);
      await logTransparencyEntry({
        sessionId: session.sessionId,
        tabIdHint: tabId,
        goal,
        step: session.history.length + 1,
        timestamp: Date.now(),
        model: settings.model,
        request: refusedPkg,
        requestDigest,
        response: null,
        gate: { decision: gate.decision, reason: "Human rejected action" },
        error: "Human rejected action",
      });

      return { decision: gate.decision, reason: "Human rejected action", stop: true };
    }
    session.status = "running";
    notifySessionUpdate(session, gate);
  }

  // Remote Agent: only the sanitized package crosses the wire — never the raw
  // dataUrl, never the element_id -> real value map. applyPlaceholders swaps
  // only `text`, so strip the user-controlled `label` (accessible label /
  // placeholder / title) to keep any raw value out of the remote context.
  // Privacy-first: NO LLM keys on this device — the package goes to the
  // operator's remote-agent server, which holds the keys and picks the brain.
  const remoteElements: ElementMeta[] = sanitized.map((el) => ({ ...el, label: null }));
  const settings = await loadModelSettings();
  session.outboundPayload = {
    sanitizedScreenshot,
    elements: remoteElements.map(({ tag, type, role, text }) => ({ tag, type, role, text })),
    placeholders: remoteElements
      .map((element) => element.text)
      .filter((text) => /^[A-Z]+_\d+$/.test(text)),
    url: pkg.browserState.url,
    model: settings.model,
  };
  notifySessionUpdate(session, gate);

  const outboundPkg = {
    goal,
    sanitizedScreenshot,
    sanitizedContext: { elements: remoteElements, browserState: pkg.browserState },
    plannerContext: buildPlannerContext(session),
    redacted: true as const, // sanitizer provenance: structural + visual redaction applied above
  };
  const requestDigest = await computeRequestDigest(outboundPkg);

  let agentAction: AgentAction;
  try {
    agentAction = await queryServer(
      outboundPkg,
      serverOptionsFromSettings(settings)
    );
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    session.status = "error";
    session.error = errorMsg;
    notifySessionUpdate(session, gate);

    // CBA-11: Log failed request to transparency audit store
    await logTransparencyEntry({
      sessionId: session.sessionId,
      tabIdHint: tabId,
      goal,
      step: session.history.length + 1,
      timestamp: Date.now(),
      model: settings.model,
      request: outboundPkg,
      requestDigest,
      response: null,
      gate: { decision: gate.decision, reason: gate.reason },
      error: errorMsg,
    });

    throw err;
  }

  // CBA-11: Record completed outbound wire exchange in transparency log
  await logTransparencyEntry({
    sessionId: session.sessionId,
    tabIdHint: tabId,
    goal,
    step: session.history.length + 1,
    timestamp: Date.now(),
    model: settings.model,
    request: outboundPkg,
    requestDigest,
    response: agentAction,
    gate: { decision: gate.decision, reason: gate.reason },
  });

  session.lastAction = agentAction;
  broadcastHudStep(5, {
    goal,
    agentAction,
  });

  // 'search' is a server-side tool resolved to navigate before the wire
  // answer. If one leaks out (old server, bug), fail closed to the human —
  // executing it locally would re-plan against an unchanged page until the
  // step budget dies.
  if (agentAction.type === "search") {
    agentAction = {
      type: "ask_human",
      reason: `The agent server returned an unresolved search ("${agentAction.query}") — check the server's SERPAPI_KEY config.`,
    };
    session.lastAction = agentAction;
  }

  if (
    session.lastFailureFingerprint === currentStateFingerprint &&
    session.lastFailureAction === JSON.stringify(agentAction)
  ) {
    const reason = "The same action failed on unchanged page state; asking for human guidance instead of retrying blindly.";
    session.history.push({
      step: session.history.length + 1,
      url: pkg.browserState.url,
      action: { type: "ask_human", reason },
      result: { ok: false, code: "EXECUTION_ERROR", error: reason },
      timestamp: Date.now(),
    });
    session.step = session.history.length;
    session.lastAction = { type: "ask_human", reason };
    session.status = "waiting_human";
    notifySessionUpdate(session, gate);
    return { decision: gate.decision, reason, stop: true };
  }

  // Terminal actions: done is terminal only after its optional configured
  // verification passes. A failed verification becomes planner feedback.
  if (agentAction.type === "done" || agentAction.type === "ask_human") {
    let result = { ok: true } as import("../types/index.js").ActionResult;
    if (agentAction.type === "done" && agentAction.verify) {
      result = (await applyActions(
        tabId,
        verificationActions(agentAction.verify, sanitized, map, goal),
        agentAction.verify.target?.ref?.frameId ?? 0
      ))[0] ?? {
        ok: false,
        code: "EXECUTION_ERROR",
        error: "Completion verification returned no result",
      };
    }
    const stepRecord = {
      step: session.history.length + 1,
      url: pkg.browserState.url,
      action: agentAction,
      result,
      timestamp: Date.now(),
    };
    session.history.push(stepRecord);
    session.step = session.history.length;
    if (!result.ok && agentAction.type === "done") {
      session.lastFailureFingerprint = currentStateFingerprint;
      session.lastFailureAction = JSON.stringify(agentAction);
      session.status = "running";
      const reason = `Completion verification failed: ${result.error ?? "unknown verification error"}`;
      broadcastHudStep(6, { actions: [], results: [result], outcome: "retry" });
      notifySessionUpdate(session, gate);
      return { decision: gate.decision, reason, actions: [result] };
    }
    session.status = agentAction.type === "done" ? "done" : "waiting_human";
    broadcastHudStep(6, { actions: [], results: [result] });
    notifySessionUpdate(session, gate);
    return { decision: gate.decision, reason: gate.reason, stop: true };
  }

  // Browser-context actions run in the background because content scripts do
  // not have tabs access. A context change always loops into a fresh capture.
  if (agentAction.type === "open_tab" || agentAction.type === "switch_tab" || agentAction.type === "close_tab" || agentAction.type === "list_tabs") {
    let result: ActionResult;
    let nextTabId: number | undefined;
    if (agentAction.type === "open_tab") {
      const opened = await openTab(agentAction.url);
      result = opened.result;
      nextTabId = opened.tabId;
    } else if (agentAction.type === "switch_tab") {
      nextTabId = tabIdForRef(agentAction.tabRef);
      result = nextTabId === undefined
        ? { ok: false, code: "EXECUTION_ERROR", error: "Unknown tab reference" }
        : await switchTab(nextTabId);
    } else if (agentAction.type === "close_tab") {
      const target = agentAction.tabRef ? tabIdForRef(agentAction.tabRef) : tabId;
      if (target === undefined) {
        result = { ok: false, code: "EXECUTION_ERROR", error: "Unknown tab reference" };
      } else {
        result = await closeTab(target);
      }
      if (result.ok && target === tabId) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        nextTabId = tabs[0]?.id;
      }
    } else {
      result = await listTabs();
    }
    if (result.ok && nextTabId !== undefined) {
      session.tabId = nextTabId;
    }
    session.history.push({ step: session.history.length + 1, url: pkg.browserState.url, action: agentAction, result, timestamp: Date.now() });
    session.step = session.history.length;
    if (!result.ok || ((agentAction.type === "open_tab" || agentAction.type === "switch_tab" || agentAction.type === "close_tab") && nextTabId === undefined)) {
      session.status = "error";
      session.error = result.error ?? "Browser context action did not produce a usable tab";
      notifySessionUpdate(session, gate);
      return { decision: gate.decision, reason: session.error, stop: true };
    }
    broadcastHudStep(6, { actions: [], results: [result], contextChanged: agentAction.type !== "list_tabs" });
    notifySessionUpdate(session, gate);
    return { decision: gate.decision, reason: gate.reason };
  }

  // CBA-5: navigate cannot run in the content-script executor (no chrome.tabs
  // access). Navigate the tab here, then loop to recapture the new page — the
  // gate runs again on the freshly loaded page, so a sensitive target
  // (e.g. IRCTC) is still Human/Block after load, never bypassed.
  if (agentAction.type === "navigate") {
    const result = await navigateTab(tabId, agentAction.url);
    const stepRecord = {
      step: session.history.length + 1,
      url: pkg.browserState.url,
      action: agentAction,
      result,
      timestamp: Date.now(),
    };
    session.history.push(stepRecord);
    session.step = session.history.length;
    broadcastHudStep(6, { actions: [], results: [result] });
    if (!result.ok) {
      // Failed navigation (e.g. load timeout): stop the session with the error
      // visible to chat instead of retrying the same navigate blindly.
      session.status = "error";
      session.error = result.error;
      notifySessionUpdate(session, gate);
      return { decision: gate.decision, reason: gate.reason, stop: true };
    }
    // Loop continues: next iteration recaptures the navigated page.
    notifySessionUpdate(session, gate);
    return { decision: gate.decision, reason: gate.reason };
  }

  // Convert the AgentAction contract into executor Actions (name/role/bbox
  // targets resolved against the sanitized elements; placeholder → real-value
  // swap happens HERE, on-device, from the local map — CONTRACT.md rule 2).
  const actions: Action[] = agentActionToExecutorActions(agentAction, sanitized, map, goal);

  // A type action without a local mapping must never become a silent no-op or
  // type its placeholder. Escalate so the human can repair the mapping/page.
  if (agentAction.type === "type" && actions.length === 0) {
    const escalation = {
      type: "ask_human" as const,
      reason: `Cannot resolve local value for ${agentAction.placeholder}`,
    };
    session.lastAction = escalation;
    session.history.push({
      step: session.history.length + 1,
      url: pkg.browserState.url,
      action: escalation,
      result: { ok: false, error: escalation.reason },
      timestamp: Date.now(),
    });
    session.step = session.history.length;
    session.status = "waiting_human";
    broadcastHudStep(6, {
      actions: [],
      results: [{ ok: false, error: escalation.reason }],
      outcome: "ask_human",
      reason: escalation.reason,
    });
    notifySessionUpdate(session, gate);
    return { decision: gate.decision, reason: escalation.reason, actions: [{ ok: false, error: escalation.reason }], stop: true };
  }

  // Local Executor: apply the returned actions on the real page DOM.
  // History/reload waits start before dispatch so an old "complete" status
  // cannot be mistaken for the new document.
  const historyKind = ["go_back", "go_forward", "reload"].includes(agentAction.type)
    ? (agentAction.type as "go_back" | "go_forward" | "reload")
    : undefined;
  const navigationWait = historyKind
    ? waitForTabTransition(tabId, pkg.browserState.url, historyKind)
    : undefined;
  const actionTarget = "target" in agentAction ? agentAction.target : undefined;
  const frameId = actionTarget?.ref?.frameId ?? 0;
  const results = await applyActions(tabId, actions, frameId);
  if (navigationWait) {
    if (results[0]?.ok) {
      const transition = await navigationWait.promise;
      if (!transition.ok) results[0] = transition;
    } else {
      navigationWait.cancel();
    }
  }
  const stepRecord = {
    step: session.history.length + 1,
    url: pkg.browserState.url,
    action: agentAction,
    result: results[0] ?? { ok: true },
    timestamp: Date.now(),
  };
  session.history.push(stepRecord);
  session.step = session.history.length;
  const result = results[0];
  if (result && !result.ok) {
    session.lastFailureFingerprint = currentStateFingerprint;
    session.lastFailureAction = JSON.stringify(agentAction);
  } else {
    delete session.lastFailureFingerprint;
    delete session.lastFailureAction;
  }
  broadcastHudStep(6, {
    actions,
    results,
  });

  // CBA-6: an executed click/type is NOT the end of the session (that was the
  // one-shot demo behaviour). Wait for any navigation it triggered to settle,
  // then loop and recapture the new page.
  notifySessionUpdate(session, gate);
  await waitForTabSettled(tabId);
  return { decision: gate.decision, reason: gate.reason, actions: results };
}
