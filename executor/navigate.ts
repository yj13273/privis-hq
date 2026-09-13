// executor/navigate.ts
// CBA-5: executes a gate-approved navigate action at the background level.
// The content-script executor has no chrome.tabs access and cannot change a
// tab's URL, so navigation runs here; runStep then recaptures the loop on the
// same (now navigated) tab.

import type { ActionResult } from "../types/index.js";

const ALLOWED_NAVIGATE_PROTOCOLS = ["http:", "https:"];
const tabRefs = new Map<string, number>();

function refForTab(tabId: number): string {
  for (const [ref, id] of tabRefs) if (id === tabId) return ref;
  const randomId = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  const ref = `tab-${randomId}`;
  tabRefs.set(ref, tabId);
  return ref;
}

export function tabIdForRef(ref: string): number | undefined {
  return tabRefs.get(ref);
}

/**
 * True only for http(s) URLs. This is a trust-boundary check independent of
 * the remote-agent guard: the executor must never navigate to a scheme the
 * guard already rejected (javascript:, file:, data:, ...), even if some future
 * caller skips the guard.
 */
export function isAllowedNavigateUrl(url: string): boolean {
  try {
    return ALLOWED_NAVIGATE_PROTOCOLS.includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Navigates the given tab to `url` (same tab — the session is bound to that
 * tabId), waits for the page to finish loading, and returns the outcome.
 * ponytail: same-tab tabs.update only; the session always has a tabId, so a
 * tabs.create branch is dead code here. If a future "open in new tab" flow
 * needs it, re-bind the session to the new tabId.
 */
export interface NavigationWait {
  promise: Promise<ActionResult>;
  cancel: () => void;
}

/**
 * Starts listening before a history/reload action is dispatched. This avoids
 * accepting the old document's already-complete status as the new result.
 */
export function waitForTabTransition(
  tabId: number,
  previousUrl: string,
  kind: "go_back" | "go_forward" | "reload",
  timeoutMs = 10000
): NavigationWait {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let sawLoading = false;
  let resolvePromise: (result: ActionResult) => void = () => {};

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    chrome.tabs.onUpdated?.removeListener(listener);
    chrome.runtime?.onMessage?.removeListener(runtimeListener);
  };
  const finish = (result: ActionResult) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise(result);
  };
  const listener = (updatedTabId: number, changeInfo: { status?: string }, tab: { url?: string }) => {
    if (updatedTabId !== tabId) return;
    if (changeInfo.status === "loading") sawLoading = true;
    if (
      changeInfo.status === "complete" &&
      (sawLoading || (kind !== "reload" && typeof tab.url === "string" && tab.url !== previousUrl))
    ) {
      finish({ ok: true });
    }
  };
  const runtimeListener = (message: unknown, sender: { tab?: { id?: number } }) => {
    if (
      kind !== "reload" &&
      typeof message === "object" && message !== null &&
      (message as { type?: string }).type === "history.transition" &&
      sender.tab?.id === tabId
    ) {
      finish({ ok: true });
    }
  };

  const promise = new Promise<ActionResult>((resolve) => {
    resolvePromise = resolve;
    if (!chrome.tabs?.onUpdated?.addListener) {
      finish({ ok: false, code: "EXECUTION_ERROR", error: "Tab update events are unavailable" });
      return;
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.runtime?.onMessage?.addListener(runtimeListener);
    timer = setTimeout(() => finish({ ok: false, code: "TIMEOUT", error: `Timed out waiting for ${kind}` }), timeoutMs);
  });

  return { promise, cancel: () => finish({ ok: false, code: "EXECUTION_ERROR", error: "Navigation wait cancelled" }) };
}

export async function openTab(url?: string): Promise<{ result: ActionResult; tabId?: number }> {
  if (typeof chrome === "undefined" || !chrome.tabs?.create) {
    return { result: { ok: false, code: "EXECUTION_ERROR", error: "chrome.tabs.create is not available" } };
  }
  if (url !== undefined && !isAllowedNavigateUrl(url)) {
    return { result: { ok: false, code: "POLICY_BLOCKED", error: "Disallowed URL — only http: and https: allowed" } };
  }
  try {
    const tab = await chrome.tabs.create(url ? { url, active: true } : { active: true });
    if (typeof tab.id !== "number") return { result: { ok: false, error: "Created tab has no id" } };
    refForTab(tab.id);
    if (url) await waitForLoad(tab.id);
    return { result: { ok: true }, tabId: tab.id };
  } catch (err) {
    return { result: { ok: false, code: "EXECUTION_ERROR", error: err instanceof Error ? err.message : String(err) } };
  }
}

export async function switchTab(tabId: number): Promise<ActionResult> {
  try {
    if (!chrome.tabs?.get || !chrome.tabs?.update) throw new Error("chrome.tabs API unavailable");
    await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, code: "EXECUTION_ERROR", error: err instanceof Error ? err.message : String(err) };
  }
}

export async function closeTab(tabId: number): Promise<ActionResult> {
  try {
    if (!chrome.tabs?.remove) throw new Error("chrome.tabs.remove is not available");
    await chrome.tabs.remove(tabId);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: "EXECUTION_ERROR", error: err instanceof Error ? err.message : String(err) };
  }
}

export async function listTabs(): Promise<ActionResult> {
  try {
    if (!chrome.tabs?.query) throw new Error("chrome.tabs.query is not available");
    const tabs = await chrome.tabs.query({});
    return { ok: true, detail: JSON.stringify(tabs.map((tab) => ({ tabRef: typeof tab.id === "number" ? refForTab(tab.id) : undefined, url: tab.url, title: tab.title, active: tab.active }))) };
  } catch (err) {
    return { ok: false, code: "EXECUTION_ERROR", error: err instanceof Error ? err.message : String(err) };
  }
}

export async function navigateTab(tabId: number, url: string): Promise<ActionResult> {
  if (typeof chrome === "undefined" || !chrome.tabs?.update) {
    return { ok: false, error: "chrome.tabs.update is not available" };
  }
  if (!isAllowedNavigateUrl(url)) {
    return { ok: false, error: `Disallowed URL "${url}" — only http: and https: allowed` };
  }
  try {
    await chrome.tabs.update(tabId, { url });
    await waitForLoad(tabId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Polls until the tab reports status "complete". Times out instead of hanging
 * the agent loop on a page that never finishes loading.
 */
async function waitForLoad(tabId: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("navigate: timed out waiting for page load");
}
