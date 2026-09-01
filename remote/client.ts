<<<<<<< HEAD
import type { Action, SanitizedPackage } from "../types/index.js";
import { assertSanitizedPackage } from "../privacy/policy-gate/privacy-gate.js";
import { validateAction } from "../executor/action-validation.js";
=======
// remote/client.ts
// Network gateway to remote agent model (only outbound network pathway).
//
// Responsibilities:
// - Sends ONLY sanitized screenshot and tokenized DOM context to remote server.
// - Returns planned actions array from remote agent.

import type { Action, ElementMeta, SanitizedPackage } from "../types/index.js";
>>>>>>> 2c04d9b03deeaf7a3cccb1d542bb1ea9812ffc02

export interface RemoteClientOptions { endpoint?: string; fetchImpl?: typeof fetch; }

export class RemoteClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RemoteClientOptions = {}) {
    this.endpoint = options.endpoint ?? "http://127.0.0.1:8787/agent/analyze";
    // WorkerGlobalScope.fetch requires its receiver; storing the bare method
    // and invoking it later causes an Illegal invocation error in MV3 workers.
    this.fetchImpl = (options.fetchImpl ?? fetch).bind(globalThis);
  }

  async analyze(pkg: SanitizedPackage): Promise<Action[]> {
    assertSanitizedPackage(pkg);
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: pkg.goal, sanitizedScreenshot: pkg.sanitizedScreenshot, sanitizedContext: pkg.sanitizedContext, redactions: pkg.redactions ?? [], schemaVersion: pkg.schemaVersion ?? "1.0" }),
    });
    if (!response.ok) throw new Error(`Remote agent request failed (${response.status})`);
    const body = await response.json() as { actions?: Action[]; action?: Action };
    const actions = Array.isArray(body.actions) ? body.actions : body.action ? [body.action] : [];
    if (!actions.every((action) => validateAction(action).ok)) throw new Error("Remote agent returned an invalid action");
    return actions;
  }
}

export async function sendSanitized(pkg: SanitizedPackage): Promise<Action[]> {
<<<<<<< HEAD
  return new RemoteClient().analyze(pkg);
=======
  assertSanitized(pkg);

  // v0 stub: no network call yet. A real VLM agent plugs in here — it would
  // POST { goal, sanitizedScreenshot, sanitizedContext } and parse Action[]
  // from the response. Until then, derive a sensible action from the real
  // sanitized DOM so the demo behaves correctly on any tab.
  return stubPlan(pkg.sanitizedContext.elements);
}

/**
 * Picks the first real clickable control from the sanitized DOM. No AI — just
 * the same kind of rule a lightweight agent would use: click a submit button,
 * a regular button, or a button/link role in document order.
 */
function stubPlan(elements: ElementMeta[]): Action[] {
  const isClickable = (el: ElementMeta): boolean =>
    el.tag === "button" ||
    el.role === "button" ||
    el.role === "link" ||
    (el.tag === "input" && (el.type === "submit" || el.type === "button"));

  const target = elements.find(isClickable);
  if (!target) return [];
  return [{ type: "click", target: selectorFor(target) }];
}

/**
 * Builds a resolver-friendly target. Real DOM ids resolve via getElementById;
 * generated ids (el-<tag>-<n>) fall back to a tag/attribute CSS selector.
 */
function selectorFor(el: ElementMeta): string {
  if (!/^el-/.test(el.element_id)) return `#${el.element_id}`;
  if (el.tag === "input" && el.type) return `input[type="${el.type}"]`;
  return el.tag;
>>>>>>> 2c04d9b03deeaf7a3cccb1d542bb1ea9812ffc02
}
