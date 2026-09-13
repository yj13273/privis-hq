// tests/test-session-e2e.ts
// CBA-6 TOUGHEST QA: full session-loop integration with the REAL pipeline.
//
// Everything is REAL except two boundaries this test cannot own:
//   REAL:  orchestrator loop (runStep/runSessionLoop), capture consistency
//          loop, vision path (YuNet ONNX via the canvas shim, f5 negative =>
//          0 faces), detectSensitive + applyPlaceholders, redactVisual,
//          policy gate, agentActionToExecutorActions (placeholder→real swap
//          on-device), queryServer wire format (assertSanitizedPackage and
//          parseAgentAction both run), local executor transport.
//   FAKE:  chrome.* APIs + a scripted page machine (no browser here), and
//          the remote brain: a scripted /plan handler on a REAL HTTP server,
//          so the actual socket wire format is exercised (no LLM keys exist
//          on this device by design — CONTRACT.md).
//
// Trails (mirrors the issue's test plan):
//   1. home → form (type ×3) → click submit → thanks → done. ONE session,
//      recapture after every action, ends only on `done`.
//   2. Brain never says done → exactly 8 steps → ask_human (waiting_human).
//   3. Wire privacy tripwire: no raw PII may ever appear in a /plan body.

import assert from "node:assert";
import { createServer, type Server } from "node:http";
import type { CaptureResponseMessage } from "../types/index.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { installCanvasShims } from "../privacy/engine/vision/test-canvas-shim.js";
import { captureStabilityFingerprint, runStep, successfulActionFingerprint } from "../orchestrator/runStep.js";
import { MAX_SESSION_STEPS, pendingHumanDecisions, sessionsByTab } from "../orchestrator/session.js";
import { computeRequestDigest } from "../orchestrator/transparency-log.js";

const stableCompose: CaptureResponseMessage[] = [{
  type: "capture.response" as const,
  payload: {
    frameId: 0,
    documentId: "doc-compose",
    snapshotVersion: 1,
    browserState: { url: "https://mail.example/", title: "Inbox", viewport: { w: 640, h: 480 } },
    elements: [
      { element_id: "recipient", tag: "input", type: "email", role: "textbox", label: null, text: "EMAIL_1", bbox: [0, 0, 100, 20], focused: false },
      { element_id: "inbox-link", tag: "a", type: null, role: "link", label: null, text: "Inbox (1)", bbox: [0, 30, 100, 20], expanded: false },
    ],
  },
}];
const volatileGmailChrome: CaptureResponseMessage[] = structuredClone(stableCompose);
volatileGmailChrome[0].payload.elements[1].text = "Inbox (2)";
volatileGmailChrome[0].payload.elements[1].expanded = true;
assert.strictEqual(captureStabilityFingerprint(stableCompose), captureStabilityFingerprint(volatileGmailChrome));
const movedRecipient: CaptureResponseMessage[] = structuredClone(stableCompose);
movedRecipient[0].payload.elements[0].bbox = [0, 10, 100, 20];
assert.notStrictEqual(captureStabilityFingerprint(stableCompose), captureStabilityFingerprint(movedRecipient));
console.log("  ✔ Capture stability ignores Gmail chrome but protects compose controls");
assert.strictEqual(
  successfulActionFingerprint({ type: "type", target: { ref: { snapshotVersion: 1, documentId: "doc", elementId: "search" } }, placeholder: "milk" }),
  successfulActionFingerprint({ type: "type", target: { ref: { snapshotVersion: 2, documentId: "doc", elementId: "search" } }, placeholder: "milk" })
);
console.log("  ✔ Successful actions remain deduplicated across fresh snapshots");
import type { ElementMeta, TransparencyLogStore } from "../types/index.js";

// ---------------------------------------------------------------------------
// Scripted world: home → form → thanks, plus an endless "loop" page.
// ---------------------------------------------------------------------------
const HOME = "http://localhost:8671/";
const FORM = "http://localhost:8671/form";
const THANKS = "http://localhost:8671/thanks";
const LOOP = "http://localhost:8671/loop";
const LEAK = "http://localhost:8671/leak";
const BANK = "https://onlinesbi.example.net/login";
const UBER = "https://riders.uber.com/login";

const SECRET_VALUES = [
  "Asha Rao",
  "asha.rao@example.in",
  "ABCDE1234F",
  "+91 98765 43210",
  "\u20B912,00,000",
  "demo-pass-123",
  "uber-pass-1",
];

function el(
  element_id: string,
  tag: string,
  text: string,
  extra: Partial<ElementMeta> = {}
): ElementMeta {
  return {
    element_id,
    tag,
    type: extra.type ?? null,
    role: extra.role ?? null,
    label: extra.label ?? null,
    text,
    bbox: extra.bbox ?? [20, 20, 200, 24],
  };
}

interface FakePage {
  url: string;
  title: string;
  elements: ElementMeta[];
}

const pages: Record<string, FakePage> = {
  [HOME]: {
    url: HOME,
    title: "HR Portal",
    elements: [
      el("title", "h1", "HR Portal", { role: "heading" }),
      el("open", "button", "Open employee portal", { role: "button" }),
    ],
  },
  [FORM]: {
    url: FORM,
    title: "Employee Portal Form",
    elements: [
      el("name", "input", "Asha Rao", { label: "Full Name", role: "textbox" }),
      el("email", "input", "asha.rao@example.in", { type: "email", role: "textbox" }),
      el("pan", "input", "ABCDE1234F", { role: "textbox" }),
      el("phone", "input", "+91 98765 43210", { type: "tel", role: "textbox" }),
      el("salary", "input", "\u20B912,00,000", { label: "Salary", role: "textbox" }),
      el("password", "input", "demo-pass-123", { type: "password", role: "textbox" }),
      el("submit", "button", "Submit", { role: "button", bbox: [20, 300, 80, 24] }),
    ],
  },
  [THANKS]: {
    url: THANKS,
    title: "HR Portal",
    elements: [el("msg", "h1", "Thanks! Your details were submitted.", { role: "heading" })],
  },
  [LOOP]: {
    url: LOOP,
    title: "HR Portal",
    elements: [el("stay", "button", "Continue", { role: "button" })],
  },
  [LEAK]: {
    url: LEAK,
    title: "Leaky Brain",
    elements: [el("open", "button", "Open", { role: "button" })],
  },
  [BANK]: {
    url: BANK,
    title: "Bank Login",
    elements: [
      el("user", "input", "asha.rao", { role: "textbox", label: "User name" }),
      el("pwd", "input", "demo-pass-123", { type: "password", role: "textbox" }),
    ],
  },
  [UBER]: {
    url: UBER,
    title: "Uber Login",
    elements: [
      el("phone", "input", "+91 98765 43210", { type: "tel", role: "textbox" }),
      el("pwd", "input", "uber-pass-1", { type: "password", role: "textbox" }),
      el("login", "button", "Log in", { role: "button" }),
    ],
  },
};

let currentPage = HOME;
const TAB = 101;
const LOOP_TAB = 202;
const captureCounts: Record<string, number> = {};
const executedActions: Array<{ type: string; target: string; value?: string }> = [];
const sessionUpdates: Array<{ status: string; steps: number; lastAction?: string }> = [];

// Real PNG fixture with ZERO faces (validated negative, f5) — the vision path
// runs REAL inference on it and contributes no detections.
const pngDataUrl =
  "data:image/png;base64," +
  readFileSync(resolve("ml/dataset/images/f5_text_negative.png")).toString("base64");

let agentPort = 0; // set after the stub server binds
const storageStore: Record<string, unknown> = {};

(globalThis as Record<string, unknown>).chrome = {
  runtime: {
    getURL: (p: string) => pathToFileURL(resolve(p)).href,
    sendMessage: async (msg: any) => {
      if (msg?.type === "cba.sessionUpdate" && msg.session) {
        sessionUpdates.push({
          status: msg.session.status,
          steps: msg.session.history.length,
          lastAction: msg.session.lastAction?.type,
        });
        // Trail 5 (Uber login): simulate the human clicking Approve the
        // moment the popup is told a gate decision needs them. The loop
        // registers waitForHumanDecision right AFTER this broadcast, so let
        // the current task finish before resolving.
        if (msg.session.status === "waiting_human") {
          await new Promise((r) => setTimeout(r, 0));
          const resolver = pendingHumanDecisions.get(msg.session.sessionId);
          if (resolver) {
            resolver(true);
            pendingHumanDecisions.delete(msg.session.sessionId);
          }
        }
      }
      return {};
    },
  },
  storage: {
    local: {
      get: async (keys?: string | string[]) => {
        const defaults: Record<string, unknown> = {
          privis_model_settings: { serverUrl: `http://127.0.0.1:${agentPort}` },
        };
        if (!keys) return { ...defaults, ...storageStore };
        const key = typeof keys === "string" ? keys : keys[0];
        return { [key]: storageStore[key] ?? defaults[key] };
      },
      set: async (items: Record<string, unknown>) => {
        Object.assign(storageStore, items);
      },
    },
  },
  tabs: {
    get: async (id: number) => ({
      id,
      windowId: 1,
      active: true,
      status: "complete",
      url: currentPage,
    }),
    update: async (id: number, props: { url?: string }) => {
      if (props?.url && pages[props.url]) currentPage = props.url;
      return { id };
    },
    captureVisibleTab: async () => pngDataUrl,
    sendMessage: async (_tabId: number, msg: any) => {
      if (msg?.type === "capture.request") {
        const page = pages[currentPage];
        captureCounts[currentPage] = (captureCounts[currentPage] ?? 0) + 1;
        return {
          type: "capture.response",
          payload: {
            elements: JSON.parse(JSON.stringify(page.elements)),
            browserState: { url: page.url, title: page.title, viewport: { w: 640, h: 480 } },
          },
        };
      }
      if (msg?.type === "execute.request") {
        const results = msg.payload.actions.map((a: any) => {
          executedActions.push(a);
          const page = pages[currentPage];
          if (a.type === "type") {
            const target = page.elements.find((e) => "#" + e.element_id === a.target);
            if (!target || a.value === undefined)
              return { ok: false, error: "type target not found: " + a.target };
            target.text = a.value;
            return { ok: true };
          }
          if (a.type === "click") {
            if (a.target === "#submit" && currentPage === FORM) {
              currentPage = THANKS; // the form submit navigates
              return { ok: true };
            }
            const hit = page.elements.find((e) => "#" + e.element_id === a.target);
            return hit ? { ok: true } : { ok: false, error: "click target not found: " + a.target };
          }
          if (a.type === "wait_for" && a.condition === "text") {
            const text = page.elements.map((e) => e.text).join(" ");
            return text.includes(a.value ?? "")
              ? { ok: true }
              : { ok: false, code: "TIMEOUT", error: "verification text not found" };
          }
          return { ok: false, error: "unsupported action: " + a.type };
        });
        return { type: "execute.response", payload: { results } };
      }
      throw new Error("unexpected content message: " + msg?.type);
    },
  },
};

// fetch chain: data: URLs → canvas shim; file:// (packaged ONNX assets) → fs;
// http://127.0.0.1:PORT (the agent server) → real Node fetch over a real socket.
const realFetch = globalThis.fetch;
(globalThis as Record<string, unknown>).fetch = async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  if (url.startsWith("file://")) {
    return new Response(readFileSync(new URL(url)), { status: 200 });
  }
  return realFetch(input, init);
};
const restoreShims = installCanvasShims();

// ---------------------------------------------------------------------------
// Scripted remote agent on a real HTTP server.
// ---------------------------------------------------------------------------
interface PlanCall {
  url: string;
  placeholders: string[];
  plannerContext?: {
    step?: number;
    phase?: string;
    lastStep?: { action?: unknown; result?: { ok?: boolean; error?: string } };
  };
  raw: string;
}
const planCalls: PlanCall[] = [];
let formCalls = 0;
let uberScriptCalls = 0;

function scriptAction(call: PlanCall): unknown {
  if (call.url === HOME) return { type: "navigate", url: FORM };
  if (call.url === LOOP) return { type: "click", target: { css: "#stay" } }; // never done → cap
  if (call.url === LEAK) return { type: "search", query: "leaky server search" }; // leaks the server-side tool
  if (call.url === FORM) {
    formCalls++;
    const ids = ["name", "email", "pan"];
    const n = formCalls;
    if (n <= 3) {
      const token = call.placeholders[n - 1];
      if (!token) return { type: "click", target: { name: "Submit" } };
      return { type: "type", target: { css: "#" + ids[n - 1] }, placeholder: token };
    }
    return { type: "click", target: { name: "Submit" } };
  }
  if (call.url === THANKS) return {
    type: "done",
    reason: "form submitted, thanks page reached",
    verify: { condition: "text", needle: "details were submitted", timeoutMs: 5000 },
  };
  if (call.url === UBER) {
    uberScriptCalls++;
    if (uberScriptCalls === 1) {
      return { type: "type", target: { css: "#phone" }, placeholder: "PHONE_1" };
    }
    return {
      type: "ask_human",
      reason: "Please enter your password in the page, then send a chat reply to continue",
    };
  }
  return { type: "ask_human", reason: "unexpected page " + call.url };
}

const server: Server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/plan") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed: any;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end("bad json");
        return;
      }
      const elements = parsed?.sanitizedContext?.elements ?? [];
      const call: PlanCall = {
        url: parsed?.sanitizedContext?.browserState?.url ?? "",
        placeholders: elements
          .map((e: any) => e.text as string)
          .filter((t: string) => /^[A-Z]+_\d+$/.test(t)),
        plannerContext: parsed?.plannerContext,
        raw: body,
      };
      planCalls.push(call);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, action: scriptAction(call) }));
    });
    return;
  }
  res.writeHead(404).end();
});

// ---------------------------------------------------------------------------
// Trails.
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== CBA-6 E2E session loop (real pipeline, scripted chrome + brain) ===");
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  agentPort = (server.address() as any).port;

  try {
    // --- Trail 1: home → form → thanks, ends on done -----------------------
    currentPage = HOME;
    const result = await runStep(TAB, "Open the HR portal and submit the employee form");
    const session = sessionsByTab.get(TAB)!;

    assert.strictEqual(session.status, "done", "trail ends only on remote `done`");
    assert.strictEqual(session.error, undefined, "clean run");
    assert.deepStrictEqual(
      session.history.map((h) => h.action.type),
      ["navigate", "type", "type", "type", "click", "done"],
      "navigate → 3× type → submit click → done, one session"
    );
    assert.strictEqual(session.step, 6);
    assert.ok(session.step <= MAX_SESSION_STEPS, "within the step budget");

    // Multi-page recapture actually happened on all three pages (each
    // capturePackage = 2 DOM snapshots; retry-on-drift can add more).
    assert.ok((captureCounts[HOME] ?? 0) >= 2, "recaptured home");
    assert.ok((captureCounts[FORM] ?? 0) >= 4 * 2, "recaptured the form page between steps");
    assert.ok((captureCounts[THANKS] ?? 0) >= 2, "recaptured the thanks page");
    assert.strictEqual(currentPage, THANKS, "click on Submit navigated to thanks");

    // Executor typed REAL values (on-device map swap), never placeholder tokens.
    const typed = executedActions.filter((a) => a.type === "type");
    assert.strictEqual(typed.length, 3, "three fields typed");
    assert.deepStrictEqual(
      typed.map((a) => [a.target, a.value]),
      [
        ["#name", "Asha Rao"],
        ["#email", "asha.rao@example.in"],
        ["#pan", "ABCDE1234F"],
      ]
    );
    assert.ok(
      executedActions.some((a) => a.type === "click" && a.target === "#submit"),
      "submit clicked"
    );

    // --- Wire privacy tripwire: the RAW HTTP body must never carry PII -----
    assert.ok(planCalls.length >= 6, "remote consulted once per step");
    assert.strictEqual(planCalls[0].plannerContext?.step, 0, "first planner call starts with empty history");
    assert.ok(
      planCalls.some(
        (call) =>
          call.plannerContext?.step === 1 &&
          call.plannerContext.lastStep?.result?.ok === true
      ),
      "later planner calls receive the previous successful action result"
    );
    for (const call of planCalls) {
      for (const secret of SECRET_VALUES) {
        assert.ok(
          !call.raw.includes(secret),
          `PII LEAK to remote agent: "${secret}" found in /plan body on ${call.url}`
        );
      }
    }
    assert.ok(
      planCalls.some((c) =>
        c.placeholders.some((p) => /^(NAME|EMAIL|PAN|PHONE|AMOUNT)_\d+$/.test(p))
      ),
      "sanitized placeholders crossed the wire (the brain needs them to act)"
    );
    assert.ok(
      planCalls.some((c) => !c.raw.includes("demo-pass-123") && c.raw.includes('"text":""')),
      "password field reached the wire with its value blanked"
    );
    assert.strictEqual(result.decision, "allow");

    // Chat was told about the transitions and the final `done`.
    assert.ok(sessionUpdates.length >= 6, "session updates streamed to chat");
    assert.strictEqual(sessionUpdates[sessionUpdates.length - 1].status, "done");
    assert.strictEqual(sessionUpdates[sessionUpdates.length - 1].lastAction, "done");
    console.log(
      "  PASS trail home → form → thanks: 6 steps, recapture after every action, only `done` ends it"
    );
    console.log(
      "  PASS wire tripwire: 0 raw PII in any /plan body; placeholders crossed; real values only in on-device executor"
    );

    // CBA-11: Verify transparency log in chrome.storage.local for Trail 1
    const tStore = storageStore["privis_transparency_log"] as TransparencyLogStore | undefined;
    assert.ok(tStore, "chrome.storage.local contains privis_transparency_log");
    const tEntries = tStore.entries.filter((e) => e.sessionId === session.sessionId);
    assert.strictEqual(tEntries.length, 6, "Transparency log contains exactly 6 entries for Trail 1");
    assert.deepStrictEqual(
      tEntries.map((e) => e.step),
      [1, 2, 3, 4, 5, 6],
      "Transparency steps are strictly ordered [1..6]"
    );
    for (const e of tEntries) {
      const digest = await computeRequestDigest(e.request);
      assert.strictEqual(e.requestDigest, digest, "Request digest matches recomputed SHA-256");
      assert.ok(e.response, "Step produced valid AgentAction");
    }
    console.log("  PASS CBA-11: Trail 1 wire transparency entries persisted, ordered, and SHA-256 verified");

    // --- Trail 2: repeated successful interaction → ask_human -------------
    formCalls = 0;
    executedActions.length = 0;
    currentPage = LOOP;
    await runStep(LOOP_TAB, "loop forever");
    const loopSession = sessionsByTab.get(LOOP_TAB)!;
    const duplicate = loopSession.history.find((h) => h.result?.code === "DUPLICATE_ACTION");
    assert.ok(duplicate, "repeated successful click is surfaced as duplicate feedback");
    assert.strictEqual(
      loopSession.history[loopSession.history.length - 1].action.type,
      "ask_human",
      "the escalation is recorded so the chat renders it"
    );
    assert.strictEqual(loopSession.lastAction?.type, "ask_human", "duplicate loop → ask_human");
    assert.strictEqual(loopSession.status, "waiting_human");
    console.log("  PASS repeated successful action → duplicate feedback → ask_human");

    // --- Trail 3: new goal after an escalation is not deadlocked -----------
    const oldId = loopSession.sessionId;
    currentPage = LOOP;
    await runStep(LOOP_TAB, "actually finish the form");
    const after = sessionsByTab.get(LOOP_TAB)!;
    assert.notStrictEqual(
      after.sessionId,
      oldId,
      "post-ask_human goal starts a fresh session (no instant re-escalation at step 8)"
    );
    assert.ok(
      after.history.some((h) => h.result?.code === "DUPLICATE_ACTION"),
      "the fresh session also stops a repeated action without reusing prior-session state"
    );
    console.log("  PASS post-escalation goal starts a fresh bounded session");

    // --- Trail 4: gate BLOCK mid-session stops the loop, zero remote calls --
    const blockedTab = 303;
    currentPage = BANK;
    const callsBefore = planCalls.length;
    const blocked = await runStep(blockedTab, "log me in");
    const bs = sessionsByTab.get(blockedTab)!;
    assert.strictEqual(bs.status, "blocked", "PASSWORD on a deny-listed bank host blocks");
    assert.strictEqual(bs.history.length, 0, "blocked before any action was planned or executed");
    assert.strictEqual(planCalls.length, callsBefore, "ZERO-CALL guard: remote never consulted");
    assert.strictEqual(blocked.decision, "block");
    assert.ok(blocked.reason.toLowerCase().includes("deny-listed"));

    // CBA-11: Verify gate block is recorded in transparency log with response: null (AC-6)
    const blockedEntries = (storageStore["privis_transparency_log"] as TransparencyLogStore).entries.filter(
      (e) => e.sessionId === bs.sessionId
    );
    assert.strictEqual(blockedEntries.length, 1, "Blocked step logged exactly 1 transparency entry");
    assert.strictEqual(blockedEntries[0].response, null, "Blocked step response is null");
    assert.strictEqual(blockedEntries[0].gate.decision, "block", "Blocked step records gate decision block");
    assert.ok(blockedEntries[0].error?.toLowerCase().includes("deny-listed"), "Blocked step records refusal reason");
    console.log("  PASS CBA-11: Gate-blocked step logged with response: null + gate reason");
    console.log("  PASS gate block mid-run stops immediately, chat told, remote never called");

    // --- Trail 5: Uber-style login — PASSWORD asks the human, not a block --
    // The v0 gate hard-blocked any page with a password field, so login flows
    // (Uber) could never run. Now: human_approval → human clears it → the
    // agent acts with the password VALUE blanked, and hands the secret field
    // back to the human via ask_human.
    const uberTab = 404;
    currentPage = UBER;
    const uberCallsBefore = planCalls.length;
    await runStep(uberTab, "Book an uber ride to the airport");
    const us = sessionsByTab.get(uberTab)!;
    assert.strictEqual(us.gateDecision, "human_approval", "PASSWORD page asks the human instead of hard-blocking");
    assert.strictEqual(us.lastAction?.type, "ask_human", "model delegates the password back to the human");
    assert.match((us.lastAction as { reason?: string }).reason ?? "", /password/i);
    assert.strictEqual(us.status, "waiting_human", "session parks for the human's password + reply");
    const uberWire = planCalls.slice(uberCallsBefore);
    assert.ok(uberWire.length >= 2, "remote consulted after the human cleared the login page");
    for (const call of uberWire) {
      assert.ok(!call.raw.includes("uber-pass-1"), `PII LEAK: password value crossed the wire`);
      assert.ok(call.raw.includes('"text":""'), "password field blanked in the wire context");
    }
    assert.ok(uberWire.some((c) => c.placeholders.includes("PHONE_1")), "phone placeholder crossed so the agent can act");
    assert.ok(
      executedActions.some((a) => a.type === "type" && a.value === "+91 98765 43210"),
      "executor typed the REAL phone value on-device (placeholder swap)"
    );
    console.log("  PASS Uber-style login: gate asks the human, wire stays clean, secret field delegated back to the human");

    // --- Trail 6: a leaked 'search' action fails closed, never re-plans ----
    const leakTab = 505;
    currentPage = LEAK;
    await runStep(leakTab, "do the thing");
    const ls = sessionsByTab.get(leakTab)!;
    assert.strictEqual(ls.lastAction?.type, "ask_human", "leaked search must escalate");
    assert.match((ls.lastAction as { reason?: string }).reason ?? "", /SERPAPI_KEY/);
    assert.strictEqual(ls.status, "waiting_human", "loop stops; page state stays untouched");
    console.log("  PASS leaked search action fails closed to ask_human in the extension");

    console.log("\nALL CBA-6 E2E LOOP TESTS PASSED");
  } finally {
    server.close();
    restoreShims();
  }
}

main().catch((err) => {
  console.error(err);
  server.close();
  process.exit(1);
});
