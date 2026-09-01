import type { Action, SanitizedPackage } from "../types/index.js";
import { assertSanitizedPackage } from "../privacy/policy-gate/privacy-gate.js";
import { validateAction } from "../executor/action-validation.js";

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
  return new RemoteClient().analyze(pkg);
}
