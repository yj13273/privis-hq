// executor/local-executor.ts
// Pipeline step 6: executes gate-approved actions locally.

import type { Action, ActionResult, ExecuteResponseMessage } from "../types/index.js";
import { sendToContent } from "../utils/messaging.js";

/**
 * Executes a sequence of actions in order on the target tab.
 * The content script runs each action and stops on the first failure.
 * @param tabId Target tab ID
 * @param actions Array of actions to apply
 */
export async function applyActions(tabId: number, actions: Action[], frameId = 0): Promise<ActionResult[]> {
  if (actions.length === 0) return [];
  try {
    const response = await sendToContent<ExecuteResponseMessage>(tabId, {
      type: "execute.request",
      payload: { actions },
    }, frameId);
    return response.payload.results;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return [{ ok: false, code: "EXECUTION_ERROR", error }];
  }
}
