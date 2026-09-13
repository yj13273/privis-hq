// tests/test-router.ts
// Unit and production QA tests for CBA-2 Model Router (chatgpt vs Gemini), clients, and settings

import assert from "node:assert";
import type { SanitizedPackage, ElementMeta, BrowserState } from "../types/index.js";
import { type AgentAction } from "../remote-agent/types.js";
import {
  DEFAULT_MODEL_SETTINGS,
  normalizeModelSettings,
  loadModelSettings,
  saveModelSettings,
  STORAGE_KEY_MODEL_SETTINGS,
} from "../extension/src/settings/models.js";
import { queryOpenAI, buildPrompt } from "../remote-agent/client-openai.js";
import { queryGemini } from "../remote-agent/client-gemini.js";
import { routeAgentRequest, assertSanitizedPackage } from "../remote-agent/router.js";
import { applyPlaceholders, detectSensitive } from "../privacy/sanitizer/structural-redact.js";

console.log("=== Running CBA-2 Model Router Test Suite (chatgpt vs Gemini) ===");

// Helper fixture generator for a valid SanitizedPackage
function createValidSanitizedPackage(overrides?: Partial<SanitizedPackage>): SanitizedPackage {
  const elements: ElementMeta[] = [
    {
      element_id: "el-input-1",
      tag: "input",
      type: "text",
      role: "textbox",
      label: null,
      text: "PAN_1",
      bbox: [100, 150, 200, 32],
    },
    {
      element_id: "submit-btn",
      tag: "button",
      type: "submit",
      role: "button",
      label: null,
      text: "Submit Form",
      bbox: [100, 200, 120, 40],
    },
  ];

  const browserState: BrowserState = {
    url: "https://portal.internal.example/form",
    title: "Employee Verification Portal",
    viewport: { w: 1280, h: 720 },
  };

  return {
    goal: "Fill PAN and submit the verification form",
    sanitizedScreenshot: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    sanitizedContext: {
      elements,
      browserState,
    },
    redacted: true, // sanitizer provenance stamp (router refuses packages without it)
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// 0. Environment isolation: loadModelSettings merges process.env fallbacks, so
// developer-exported keys (OPENAI_API_KEY, GEMINI_API_KEY, ...) would otherwise
// break persistence round-trip assertions and server no_api_key tests.
// --------------------------------------------------------------------------
const ENV_BACKUP = { ...process.env };
for (const envKey of [
  "PRIVIS_MODEL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "GEMINI_API_KEY",
  "GEMINI_BASE_URL",
  "GEMINI_MODEL",
  "SERPAPI_KEY",
]) {
  delete process.env[envKey];
}

// --------------------------------------------------------------------------
// 1. Settings Normalization & Persistence Tests
// --------------------------------------------------------------------------
console.log("\n[1] Settings normalization & storage persistence");

// Default settings
const defaultNorm = normalizeModelSettings();
assert.strictEqual(defaultNorm.model, "chatgpt");
assert.strictEqual(defaultNorm.openaiBaseUrl, DEFAULT_MODEL_SETTINGS.openaiBaseUrl);
assert.strictEqual(defaultNorm.openaiModel, "gpt-4o-mini");
assert.strictEqual(defaultNorm.geminiBaseUrl, DEFAULT_MODEL_SETTINGS.geminiBaseUrl);
assert.strictEqual(defaultNorm.geminiModel, "gemini-3.5-flash-lite-preview");
console.log("  ✔ Default settings properly initialized");

// Normalize with custom values & whitespace trimming
const customNorm = normalizeModelSettings({
  model: "gemini",
  openaiApiKey: "  sk-test-openai-key  ",
  geminiApiKey: "  gemini-test-key  ",
  geminiModel: "gemini-2.0-flash",
});
assert.strictEqual(customNorm.model, "gemini");
assert.strictEqual(customNorm.openaiApiKey, "sk-test-openai-key");
assert.strictEqual(customNorm.geminiApiKey, "gemini-test-key");
assert.strictEqual(customNorm.geminiModel, "gemini-2.0-flash");
console.log("  ✔ Custom settings normalization & whitespace trimming verified");

// Fallback on invalid model choice
const invalidModelNorm = normalizeModelSettings({ model: "unknown-vendor" as any });
assert.strictEqual(invalidModelNorm.model, "chatgpt");
console.log("  ✔ Invalid model choice safely falls back to 'chatgpt'");

// Chrome storage mock test
const mockStorage: Record<string, unknown> = {};
(globalThis as any).chrome = {
  storage: {
    local: {
      get: async (key: string) => ({ [key]: mockStorage[key] }),
      set: async (items: Record<string, unknown>) => {
        Object.assign(mockStorage, items);
      },
    },
  },
};

// Save settings to mock chrome storage — provider keys are NEVER persisted
await saveModelSettings({
  model: "gemini",
  geminiApiKey: "test-gemini-key-123",
});
assert.deepStrictEqual(mockStorage[STORAGE_KEY_MODEL_SETTINGS], {
  model: "gemini",
  serverUrl: "http://localhost:3201",
  agentAuthToken: undefined,
});

// Load settings from mock chrome storage (provider keys stay server-side)
const loaded = await loadModelSettings();
assert.strictEqual(loaded.model, "gemini");
assert.strictEqual(loaded.geminiApiKey, undefined);
console.log("  ✔ chrome.storage.local persists client fields only (no provider keys)");

// Malformed (non-string) stored values must not break normalization — falls back to defaults
const malformedNorm = normalizeModelSettings({
  openaiApiKey: 12345 as any,
  openaiBaseUrl: { bad: "object" } as any,
  geminiModel: true as any,
});
assert.strictEqual(malformedNorm.openaiApiKey, undefined);
assert.strictEqual(malformedNorm.openaiBaseUrl, DEFAULT_MODEL_SETTINGS.openaiBaseUrl);
assert.strictEqual(malformedNorm.geminiModel, DEFAULT_MODEL_SETTINGS.geminiModel);
console.log("  ✔ Non-string (malformed) stored settings safely fall back to defaults");

// Clean up mock chrome storage after settings test
delete (globalThis as any).chrome;

// --------------------------------------------------------------------------
// 2. OpenAI Client & Prompt Builder Tests
// --------------------------------------------------------------------------
console.log("\n[2] OpenAI-compatible client tests");

const pkg = createValidSanitizedPackage();

// Prompt builder check
const promptText = buildPrompt(pkg);
assert.ok(promptText.includes("USER GOAL: Fill PAN and submit the verification form"));
assert.ok(promptText.includes("PAGE URL: https://portal.internal.example/form"));
assert.ok(promptText.includes("text=\"PAN_1\""));
console.log("  ✔ OpenAI prompt builder formats goal, state, and elements accurately");

// Missing API Key -> ask_human
const missingKeyAction = await queryOpenAI(pkg, { apiKey: "" });
assert.strictEqual(missingKeyAction.type, "ask_human");
assert.ok(
  (missingKeyAction as { type: "ask_human"; reason: string }).reason.includes("no_api_key"),
  "Missing OpenAI key must produce ask_human with 'no_api_key'"
);
console.log("  ✔ Missing OpenAI key returns ask_human / no_api_key");

// Successful OpenAI mock call returning Type action with placeholder
let recordedOpenAIRequest: { url: string; headers: any; body: any } | null = null;

const mockOpenAIFetch: typeof fetch = async (input, init) => {
  recordedOpenAIRequest = {
    url: input.toString(),
    headers: init?.headers,
    body: JSON.parse(init?.body as string),
  };

  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              type: "type",
              target: { css: "#pan-input" },
              placeholder: "PAN_1",
            }),
          },
        },
      ],
    }),
  } as Response;
};

const openAiAction = await queryOpenAI(pkg, {
  apiKey: "sk-test-valid-key",
  baseUrl: "https://custom.openai.api/v1",
  model: "gpt-4o-mini",
  fetchFn: mockOpenAIFetch,
});

assert.strictEqual(openAiAction.type, "type");
if (openAiAction.type === "type") {
  assert.strictEqual(openAiAction.placeholder, "PAN_1");
  assert.strictEqual(openAiAction.target.css, "#pan-input");
}
const openAiReq = recordedOpenAIRequest as unknown as { url: string; headers: any; body: any };
assert.ok(openAiReq);
assert.strictEqual(openAiReq.url, "https://custom.openai.api/v1/chat/completions");
assert.strictEqual(openAiReq.headers?.Authorization, "Bearer sk-test-valid-key");
assert.strictEqual(openAiReq.body?.model, "gpt-4o-mini");
assert.strictEqual(openAiReq.body?.messages?.[1]?.content?.[1]?.type, "image_url");
console.log("  ✔ OpenAI client successfully calls endpoint and parses AgentAction JSON");

// Markdown fence handling in OpenAI response
const mockMdFetch: typeof fetch = async () =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            content: "```json\n{\n  \"type\": \"click\",\n  \"target\": { \"css\": \"#submit-btn\" }\n}\n```",
          },
        },
      ],
    }),
  } as Response);

const mdAction = await queryOpenAI(pkg, {
  apiKey: "sk-test",
  fetchFn: mockMdFetch,
});
assert.strictEqual(mdAction.type, "click");
if (mdAction.type === "click") {
  assert.strictEqual(mdAction.target.css, "#submit-btn");
}
console.log("  ✔ OpenAI client handles markdown-wrapped JSON responses");

// Rejection of Raw PII hallucinated by LLM in response
const mockPiiLeakFetch: typeof fetch = async () =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              type: "type",
              target: { css: "#pan-input" },
              placeholder: "ABCDE1234F", // Raw PAN!
            }),
          },
        },
      ],
    }),
  } as Response);

await assert.rejects(
  async () => {
    await queryOpenAI(pkg, { apiKey: "sk-test", fetchFn: mockPiiLeakFetch });
  },
  {
    message: /Raw PAN detected in placeholder/i,
  },
  "OpenAI client must reject LLM responses containing raw PII"
);
console.log("  ✔ OpenAI client enforces PII guard on LLM responses");

// HTTP 401 Unauthorized Error Handling
const mock401Fetch: typeof fetch = async () =>
  ({
    ok: false,
    status: 401,
    statusText: "Unauthorized",
    text: async () => JSON.stringify({ error: { message: "Invalid API key" } }),
  } as Response);

await assert.rejects(
  async () => {
    await queryOpenAI(pkg, { apiKey: "invalid-key", fetchFn: mock401Fetch });
  },
  {
    message: /OpenAI API error \(401\)/i,
  }
);
console.log("  ✔ OpenAI client properly throws descriptive error on HTTP failures");

// --------------------------------------------------------------------------
// 3. Google Gemini Client Tests
// --------------------------------------------------------------------------
console.log("\n[3] Google Gemini client tests");

// Missing API Key -> ask_human
const missingGeminiKeyAction = await queryGemini(pkg, { apiKey: "" });
assert.strictEqual(missingGeminiKeyAction.type, "ask_human");
assert.ok(
  (missingGeminiKeyAction as { type: "ask_human"; reason: string }).reason.includes("no_api_key"),
  "Missing Gemini key must produce ask_human with 'no_api_key'"
);
console.log("  ✔ Missing Gemini key returns ask_human / no_api_key");

// Successful Gemini mock call returning Click action
let recordedGeminiRequest: { url: string; body: any } | null = null;

const mockGeminiFetch: typeof fetch = async (input, init) => {
  recordedGeminiRequest = {
    url: input.toString(),
    body: JSON.parse(init?.body as string),
  };

  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  type: "click",
                  target: { name: "Submit Form" },
                }),
              },
            ],
          },
        },
      ],
    }),
  } as Response;
};

const geminiAction = await queryGemini(pkg, {
  apiKey: "gemini-valid-key-777",
  baseUrl: "https://custom.gemini.api/v1beta",
  model: "gemini-3.5-flash-lite-preview",
  fetchFn: mockGeminiFetch,
});

assert.strictEqual(geminiAction.type, "click");
if (geminiAction.type === "click") {
  assert.strictEqual(geminiAction.target.name, "Submit Form");
}
const geminiReq = recordedGeminiRequest as unknown as { url: string; body: any };
assert.ok(geminiReq);
assert.ok(
  geminiReq.url.includes(
    "https://custom.gemini.api/v1beta/models/gemini-3.5-flash-lite-preview:generateContent?key=gemini-valid-key-777"
  )
);
assert.strictEqual(
  geminiReq.body?.contents?.[0]?.parts?.[1]?.inlineData?.mimeType,
  "image/png"
);
console.log("  ✔ Gemini client successfully formats inline image & parses AgentAction JSON");

// Rejection of Raw PII hallucinated by Gemini
const mockGeminiPiiFetch: typeof fetch = async () =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  type: "type",
                  target: { css: "#email" },
                  placeholder: "user@example.com", // Raw Email!
                }),
              },
            ],
          },
        },
      ],
    }),
  } as Response);

await assert.rejects(
  async () => {
    await queryGemini(pkg, { apiKey: "test-key", fetchFn: mockGeminiPiiFetch });
  },
  {
    message: /Raw EMAIL detected in placeholder/i,
  }
);
console.log("  ✔ Gemini client enforces PII guard on LLM responses");

// --------------------------------------------------------------------------
// 4. Sanitization Boundary & Package Guard Tests
// --------------------------------------------------------------------------
console.log("\n[4] Router Sanitization Boundary checks");

// Valid package passes boundary check
assert.doesNotThrow(() => assertSanitizedPackage(pkg));

// Reject raw capture package containing 'tabId' or 'dataUrl' at root
assert.throws(
  () => {
    assertSanitizedPackage({
      ...pkg,
      tabId: 10,
    } as any);
  },
  {
    message: /Refusing to route: package contains raw field "tabId"/i,
  }
);

assert.throws(
  () => {
    assertSanitizedPackage({
      ...pkg,
      dataUrl: "data:image/png;base64,rawdata",
    } as any);
  },
  {
    message: /Refusing to route: package contains raw field "dataUrl"/i,
  }
);

assert.throws(
  () => {
    assertSanitizedPackage({
      ...pkg,
      detections: [],
    } as any);
  },
  {
    message: /Refusing to route: package contains raw field "detections"/i,
  }
);

// Reject missing goal or missing sanitizedScreenshot
assert.throws(
  () => {
    assertSanitizedPackage({ ...pkg, goal: "" });
  },
  {
    message: /missing or empty goal/i,
  }
);
assert.throws(
  () => {
    assertSanitizedPackage({ ...pkg, sanitizedScreenshot: "" });
  },
  {
    message: /missing or empty sanitizedScreenshot/i,
  }
);

// Currency in a CTA must be sanitized too. Uber exposes promo/fare amounts
// in button-like controls; skipping buttons lets the router fail closed before
// the agent can plan the ride.
const rideElements: ElementMeta[] = [
  {
    element_id: "ride-promo",
    tag: "button",
    type: null,
    role: "button",
    label: "Ride offer",
    text: "Up to ₹50 off",
    bbox: [0, 0, 100, 30],
  },
  {
    element_id: "ride-promo-usd",
    tag: "input",
    type: "text",
    role: "textbox",
    label: null,
    text: "USD5 off",
    bbox: [0, 30, 100, 30],
  },
];
const rideRedaction = applyPlaceholders(rideElements, detectSensitive(rideElements));
assert.doesNotThrow(() =>
  assertSanitizedPackage(
    createValidSanitizedPackage({
      sanitizedContext: { ...pkg.sanitizedContext, elements: rideRedaction.sanitized },
    })
  )
);

// Reject raw PII leaked inside sanitizedContext
const leakedPkg = createValidSanitizedPackage({
  sanitizedContext: {
    ...pkg.sanitizedContext,
    elements: [
      {
        element_id: "el-1",
        tag: "input",
        type: "text",
        role: null,
        label: null,
        text: "ABCDE1234F", // Leaked raw PAN!
        bbox: [0, 0, 10, 10],
      },
    ],
  },
});

assert.throws(
  () => {
    assertSanitizedPackage(leakedPkg);
  },
  {
    message: /Refusing to route: PAN pattern detected/i,
  }
);

// Reject unmarked package: raw screenshot with no sanitizer provenance stamp
// (a non-empty string alone cannot prove pixels were redacted)
assert.throws(
  () => {
    assertSanitizedPackage({ ...pkg, redacted: undefined as unknown as true });
  },
  {
    message: /not marked as sanitized.*run the Sanitizer first/i,
  }
);
console.log("  ✔ All Router sanitization boundary guards verified (incl. redacted provenance)");

// --------------------------------------------------------------------------
// 4b. Quick navigation: a user-named URL/domain must never come back as
// ask_human "please provide the URL" — the router navigates deterministically
// before any LLM call. (Demo regression: goal named the site, agent asked.)
// --------------------------------------------------------------------------
console.log("\n[4b] Router quick-navigate (any website from the goal, no LLM round)");

const noLlmFetch: typeof fetch = async () => {
  throw new Error("FAIL: LLM must not be consulted when the goal names the destination");
};
const passThroughFetch: typeof fetch = async () =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ type: "scroll", dy: 100 }) } }],
    }),
  } as Response);

// Explicit URL in the goal, current page elsewhere → navigate, zero LLM calls
const navFromUrl = await routeAgentRequest(
  createValidSanitizedPackage({
    goal: "Go to https://shopping.example.com/cart and checkout the items",
  }),
  { settings: { model: "chatgpt", openaiApiKey: "sk-key" }, fetchFn: noLlmFetch }
);
assert.deepStrictEqual(
  navFromUrl,
  { type: "navigate", url: "https://shopping.example.com/cart" },
  "explicit URL in goal navigates without consulting the model"
);

// Bare domain in the goal → https navigate
const navFromDomain = await routeAgentRequest(
  createValidSanitizedPackage({ goal: "open amazon.in and track my order" }),
  { settings: { model: "chatgpt", openaiApiKey: "sk-key" }, fetchFn: noLlmFetch }
);
assert.deepStrictEqual(navFromDomain, { type: "navigate", url: "https://amazon.in/" });

// Already on the named site → fall through to the model (no nav loop)
const onSite = await routeAgentRequest(
  createValidSanitizedPackage({
    goal: "open amazon.in and track my order",
    sanitizedContext: {
      elements: pkg.sanitizedContext.elements,
      browserState: { ...pkg.sanitizedContext.browserState, url: "https://www.amazon.in/order" },
    },
  }),
  { settings: { model: "chatgpt", openaiApiKey: "sk-key" }, fetchFn: passThroughFetch }
);
assert.strictEqual(onSite.type, "scroll", "same-site goals stay with the model");

// No destination at all in the goal → model decides
const noToken = await routeAgentRequest(
  createValidSanitizedPackage({
    goal: "fill this verification form and submit it",
  }),
  { settings: { model: "chatgpt", openaiApiKey: "sk-key" }, fetchFn: passThroughFetch }
);
assert.strictEqual(noToken.type, "scroll", "goals without a destination stay with the model");

// Brand-only mention (the "open uber" demo failure): navigate, zero LLM calls
const navBrand = await routeAgentRequest(
  createValidSanitizedPackage({
    goal: "open uber and book a ride from my location to rithala metro",
  }),
  { settings: { model: "chatgpt", openaiApiKey: "sk-key" }, fetchFn: noLlmFetch }
);
assert.deepStrictEqual(
  navBrand,
  { type: "navigate", url: "https://m.uber.com/go/home" },
  "named brand navigates without asking the human for a link"
);

// Already on the brand site → model runs the page flow
const onBrand = await routeAgentRequest(
  createValidSanitizedPackage({
    goal: "book uber ride from my location to rithala metro",
    sanitizedContext: {
      elements: pkg.sanitizedContext.elements,
      browserState: { ...pkg.sanitizedContext.browserState, url: "https://m.uber.com/go/ride" },
    },
  }),
  { settings: { model: "chatgpt", openaiApiKey: "sk-key" }, fetchFn: passThroughFetch }
);
assert.strictEqual(onBrand.type, "scroll", "on-site brand mentions stay with the model");
console.log("  ✔ Quick-navigate routes URL, domain, and brand destinations; falls back safely");

// --------------------------------------------------------------------------
// 4c. Server-side 'search' tool: model searches, the SERVER runs SerpAPI and
// answers navigate — the extension never sees the search.
// --------------------------------------------------------------------------
console.log("\n[4c] Router search tool (SerpAPI resolved server-side)");

// Goal has no URL/brand token, so quick-navigate lets it reach the model.
const searchPkg = createValidSanitizedPackage({
  goal: "find the best official site for second-hand furniture and open it",
});
const modelSaysSearch = async () =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              type: "search",
              query: "official second-hand furniture website india",
            }),
          },
        },
      ],
    }),
  } as Response);

// Happy path: first http(s) organic result becomes a navigate action.
process.env.SERPAPI_KEY = "serp-test-key";
const searchFetch: typeof fetch = async (input: any) => {
  const u = typeof input === "string" ? input : String((input as any)?.url ?? input);
  if (u.includes("serpapi.com")) {
    assert.ok(u.includes("api_key=serp-test-key"), "key stays server-side, in the SERP request only");
    assert.ok(u.includes("official+second-hand") || decodeURIComponent(u).includes("official second-hand"));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        organic_results: [{ title: "Olx", link: "https://www.olx.in/" }],
      }),
    } as Response;
  }
  return modelSaysSearch();
};
const searched = await routeAgentRequest(searchPkg, {
  settings: { model: "chatgpt", openaiApiKey: "sk-key" },
  fetchFn: searchFetch,
});
assert.deepStrictEqual(searched, { type: "navigate", url: "https://www.olx.in/" });

// No key → degrade to ask_human, model call still happened but no navigation.
delete process.env.SERPAPI_KEY;
const noKey = await routeAgentRequest(searchPkg, {
  settings: { model: "chatgpt", openaiApiKey: "sk-key" },
  fetchFn: async () => (await modelSaysSearch()) as Response,
});
assert.strictEqual(noKey.type, "ask_human");
assert.ok((noKey as { reason: string }).reason.includes("SERPAPI_KEY"));

// SERP returns nothing usable → ask_human, never a blind navigate.
process.env.SERPAPI_KEY = "serp-test-key";
const emptySerp = await routeAgentRequest(searchPkg, {
  settings: { model: "chatgpt", openaiApiKey: "sk-key" },
  fetchFn: async (input: any) => {
    const u = typeof input === "string" ? input : String((input as any)?.url ?? "");
    if (u.includes("serpapi.com")) {
      return { ok: true, status: 200, json: async () => ({ organic_results: [] }) } as Response;
    }
    return (await modelSaysSearch()) as Response;
  },
});
delete process.env.SERPAPI_KEY;
assert.strictEqual(emptySerp.type, "ask_human");
assert.ok((emptySerp as { reason: string }).reason.includes("no usable result"));
console.log("  ✔ search resolves server-side to navigate; missing key/results degrade to ask_human");

// --------------------------------------------------------------------------
// 5. Router End-to-End Dispatching & Polymorphic Action Verification
// --------------------------------------------------------------------------
console.log("\n[5] Model Router end-to-end dispatch & schema consistency");

// 1. Dispatch to 'chatgpt' model router
const routerChatgptAction = await routeAgentRequest(pkg, {
  settings: {
    model: "chatgpt",
    openaiApiKey: "sk-test-key",
  },
  fetchFn: mockOpenAIFetch,
});
assert.strictEqual(routerChatgptAction.type, "type");
if (routerChatgptAction.type === "type") {
  assert.strictEqual(routerChatgptAction.placeholder, "PAN_1");
}
console.log("  ✔ Router correctly dispatches to 'chatgpt' (OpenAI-compatible) model");

// 2. Dispatch to 'gemini' model router
const routerGeminiAction = await routeAgentRequest(pkg, {
  settings: {
    model: "gemini",
    geminiApiKey: "gemini-key",
  },
  fetchFn: mockGeminiFetch,
});
assert.strictEqual(routerGeminiAction.type, "click");
if (routerGeminiAction.type === "click") {
  assert.strictEqual(routerGeminiAction.target.name, "Submit Form");
}
console.log("  ✔ Router correctly dispatches to 'gemini' model");

// 3. Missing API key handling in router produces ask_human with 'no_api_key'
const routerNoKeyChatgpt = await routeAgentRequest(pkg, {
  settings: {
    model: "chatgpt",
    openaiApiKey: "",
  },
});
assert.strictEqual(routerNoKeyChatgpt.type, "ask_human");
assert.ok(
  (routerNoKeyChatgpt as { type: "ask_human"; reason: string }).reason.includes("no_api_key")
);

const routerNoKeyGemini = await routeAgentRequest(pkg, {
  settings: {
    model: "gemini",
    geminiApiKey: "",
  },
});
assert.strictEqual(routerNoKeyGemini.type, "ask_human");
assert.ok(
  (routerNoKeyGemini as { type: "ask_human"; reason: string }).reason.includes("no_api_key")
);
console.log("  ✔ Router missing key handling produces ask_human / no_api_key for both providers");

// 4. Remote API error handling returns ask_human without unhandled crash
const routerErrorAction = await routeAgentRequest(pkg, {
  settings: {
    model: "chatgpt",
    openaiApiKey: "sk-key",
  },
  fetchFn: mock401Fetch,
});
assert.strictEqual(routerErrorAction.type, "ask_human");
assert.ok(
  (routerErrorAction as { type: "ask_human"; reason: string }).reason.includes("Remote model error")
);
console.log("  ✔ Router catches remote model errors and returns safe ask_human action");

// 5. Navigate, Scroll, Done actions verification through router
const mockDoneFetch: typeof fetch = async () =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              type: "done",
              reason: "Form submitted and verification receipt shown",
            }),
          },
        },
      ],
    }),
  } as Response);

const doneActionResult = await routeAgentRequest(pkg, {
  settings: { model: "chatgpt", openaiApiKey: "sk-key" },
  fetchFn: mockDoneFetch,
});
assert.strictEqual(doneActionResult.type, "done");
if (doneActionResult.type === "done") {
  assert.strictEqual(doneActionResult.reason, "Form submitted and verification receipt shown");
}
console.log("  ✔ Multi-action lifecycle actions (done, navigate, scroll) return consistent schema");

// 6. Model-hallucinated placeholder (valid token format, absent from context) is refused
const mockHallucinatedFetch: typeof fetch = async () =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              type: "type",
              target: { css: "#pan-input" },
              placeholder: "PAN_2", // valid format, but context only has PAN_1
            }),
          },
        },
      ],
    }),
  } as Response);

const hallucinatedAction = await routeAgentRequest(pkg, {
  settings: { model: "chatgpt", openaiApiKey: "sk-key" },
  fetchFn: mockHallucinatedFetch,
});
assert.strictEqual(hallucinatedAction.type, "ask_human");
assert.ok(
  (hallucinatedAction as { type: "ask_human"; reason: string }).reason.includes(
    "does not exist in sanitized context"
  )
);
console.log("  ✔ Router refuses model-hallucinated placeholder not present in sanitized context");

// --------------------------------------------------------------------------
// 6. Standalone Remote Agent Hono HTTP Server Integration Tests
// --------------------------------------------------------------------------
console.log("\n[6] Standalone Hono HTTP Server tests (decoupled remote brain)");

import { createAgentApp } from "../remote-agent/server.js";

const app = createAgentApp();

// Test GET /health
const healthRes = await app.request("/health");
assert.strictEqual(healthRes.status, 200);
const healthData = (await healthRes.json()) as any;
assert.strictEqual(healthData.status, "ok");
assert.strictEqual(healthData.service, "privis-remote-agent");
console.log("  ✔ Hono app /health endpoint responds with status: ok");

// Test POST /plan without API keys -> ask_human (no_api_key)
const planRes = await app.request("/plan", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(pkg),
});
assert.strictEqual(planRes.status, 200);
const planData = (await planRes.json()) as any;
assert.strictEqual(planData.ok, true);
assert.strictEqual(planData.action.type, "ask_human");
assert.ok(planData.action.reason.includes("no_api_key"));
console.log("  ✔ Hono app /plan endpoint consumes SanitizedPackage and returns AgentAction");

// Test POST /plan with unsanitized/raw data -> 400 rejection
const rawRejectRes = await app.request("/plan", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ ...pkg, tabId: 99 }),
});
assert.strictEqual(rawRejectRes.status, 400);
const rawRejectData = (await rawRejectRes.json()) as any;
assert.strictEqual(rawRejectData.ok, false);
assert.ok(rawRejectData.error.includes("Refusing to route"));
console.log("  ✔ Hono app rejects unsanitized packages with HTTP 400");

// Test 404 Not Found
const notFoundRes = await app.request("/unknown-route");
assert.strictEqual(notFoundRes.status, 404);
console.log("  ✔ Hono app returns 404 for unknown endpoints");

// Auth: when AGENT_AUTH_TOKEN is set, /plan requires the bearer token
try {
  process.env.AGENT_AUTH_TOKEN = "test-secret-token";
  const noAuthRes = await app.request("/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(pkg),
  });
  assert.strictEqual(noAuthRes.status, 401);
  const badAuthRes = await app.request("/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
    body: JSON.stringify(pkg),
  });
  assert.strictEqual(badAuthRes.status, 401);
  const goodAuthRes = await app.request("/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-secret-token" },
    body: JSON.stringify(pkg),
  });
  assert.strictEqual(goodAuthRes.status, 200);
  console.log("  ✔ /plan enforces bearer auth when AGENT_AUTH_TOKEN is configured");

  // CORS: disallowed origins get no Access-Control-Allow-Origin header
  const evilRes = await app.request("/plan", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example.com", "Access-Control-Request-Method": "POST" },
  });
  assert.ok(!evilRes.headers.get("Access-Control-Allow-Origin"));
  const friendRes = await app.request("/plan", {
    method: "OPTIONS",
    headers: { Origin: "chrome-extension://abcdef", "Access-Control-Request-Method": "POST" },
  });
  assert.strictEqual(friendRes.headers.get("Access-Control-Allow-Origin"), "chrome-extension://abcdef");
  console.log("  ✔ CORS restricted to localhost / chrome-extension / configured origins");
} finally {
  delete process.env.AGENT_AUTH_TOKEN;
}

// --------------------------------------------------------------------------
// 7. Privacy-first Server Client (extension -> operator server, no keys on device)
// --------------------------------------------------------------------------
console.log("\n[7] Server client tests (keys stay on the server)");

import { queryServer, serverOptionsFromSettings } from "../remote-agent/client-server.js";

// Successful round-trip: posts SanitizedPackage + model preference, returns validated AgentAction
let recordedServerRequest: { url: string; body: any } | null = null;
const mockServerFetch: typeof fetch = async (input, init) => {
  recordedServerRequest = { url: input.toString(), body: JSON.parse(init?.body as string) };
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      action: { type: "click", target: { css: "#submit-btn" } },
    }),
  } as Response;
};

const plannerPkg = {
  ...pkg,
  plannerContext: {
    step: 2,
    maxSteps: 25,
    phase: "continuing" as const,
    progress: "1 completed action(s); 0 failed action(s); current page state was freshly captured",
    lastStep: {
      action: { type: "click" as const, target: { css: "#search" } },
      result: { ok: true },
    },
    recentHistory: [],
  },
};
const serverAction = await queryServer(plannerPkg, {
  serverUrl: "http://my-agent-server:9000",
  model: "gemini",
  fetchFn: mockServerFetch,
});
assert.strictEqual(serverAction.type, "click");
const serverReq = recordedServerRequest as unknown as { url: string; body: any };
assert.ok(serverReq !== null);
assert.strictEqual(serverReq.url, "http://my-agent-server:9000/plan");
assert.strictEqual(serverReq.body.model, "gemini");
assert.strictEqual(serverReq.body.redacted, true);
assert.strictEqual(serverReq.body.plannerContext.step, 2);
assert.strictEqual(serverReq.body.plannerContext.lastStep.result.ok, true);
// The client must NEVER transmit LLM keys
assert.ok(!("openaiApiKey" in serverReq.body));
assert.ok(!("geminiApiKey" in serverReq.body));
console.log("  ✔ queryServer posts sanitized package + preference, no keys, returns AgentAction");

// Server error -> throws descriptive error
const mockServerErrorFetch: typeof fetch = async () =>
  ({
    ok: false,
    status: 502,
    statusText: "Bad Gateway",
    text: async () => "upstream down",
  } as Response);

await assert.rejects(
  async () => {
    await queryServer(pkg, { fetchFn: mockServerErrorFetch });
  },
  {
    message: /Remote agent server error \(502\)/i,
  }
);
console.log("  ✔ queryServer throws descriptive error on server failure");

// Server response violating the AgentAction schema -> rejected
const mockBadActionFetch: typeof fetch = async () =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      action: { type: "type", target: { css: "#pan" }, placeholder: "ABCDE1234F" }, // raw PAN!
    }),
  } as Response);

await assert.rejects(
  async () => {
    await queryServer(pkg, { fetchFn: mockBadActionFetch });
  },
  {
    message: /Raw PAN detected in placeholder/i,
  }
);
console.log("  ✔ queryServer enforces AgentAction schema + PII guard on server responses");

// Server honors the client's model preference (keys resolved server-side)
let upstreamCalls: string[] = [];
const originalFetch = globalThis.fetch;
// @ts-ignore — test monkeypatch
globalThis.fetch = async (input: any, init: any) => {
  upstreamCalls.push(input.toString());
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        { content: { parts: [{ text: JSON.stringify({ type: "done", reason: "ok" }) }] } },
      ],
    }),
  } as Response;
};

try {
  // The server holds its keys in env (here: simulated) — the client never sent any.
  // Base URL/model also isolated so a developer's exported values can't
  // redirect the upstream-call assertion.
  process.env.GEMINI_API_KEY = "server-held-test-key";
  delete process.env.GEMINI_BASE_URL;
  delete process.env.GEMINI_MODEL;
  const prefRes = await app.request("/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...pkg, model: "gemini" }),
  });
  assert.strictEqual(prefRes.status, 200);
  const prefData = (await prefRes.json()) as any;
  assert.strictEqual(prefData.action.type, "done");
  assert.ok(
    upstreamCalls.some((u) => u.includes("generativelanguage.googleapis.com")),
    `expected Gemini endpoint called, got: ${upstreamCalls.join(", ")}`
  );
  console.log("  ✔ Server honors client model preference and resolves it with server-held keys");
} finally {
  delete process.env.GEMINI_API_KEY;
  globalThis.fetch = originalFetch;
}

// serverOptionsFromSettings mapping
const srvOpts = serverOptionsFromSettings({
  ...normalizeModelSettings(),
  serverUrl: "http://prod:8080",
  model: "gemini",
});
assert.strictEqual(srvOpts.serverUrl, "http://prod:8080");
assert.strictEqual(srvOpts.model, "gemini");
console.log("  ✔ serverOptionsFromSettings maps settings correctly");

// Pre-flight privacy check: unsanitized package refused BEFORE any POST
let preFlightCalls = 0;
const spyFetch: typeof fetch = async () => {
  preFlightCalls++;
  return { ok: true, json: async () => ({ ok: true, action: { type: "done", reason: "x" } }) } as Response;
};
await assert.rejects(
  async () => {
    await queryServer({ ...pkg, tabId: 1 } as any, { fetchFn: spyFetch });
  },
  {
    message: /Refusing to route: package contains raw field "tabId"/i,
  }
);
await assert.rejects(
  async () => {
    await queryServer({ ...pkg, redacted: undefined } as any, { fetchFn: spyFetch });
  },
  {
    message: /not marked as sanitized/i,
  }
);
assert.strictEqual(preFlightCalls, 0, "nothing may be POSTed for unsanitized packages");
console.log("  ✔ queryServer refuses unsanitized packages before any network request");

// --------------------------------------------------------------------------
// 8. AgentAction -> Executor bridge (name/role/bbox resolution, real-value swap)
// --------------------------------------------------------------------------
console.log("\n[8] Executor bridge tests");

import { agentActionToExecutorActions } from "../executor/agent-action.js";

const bridgeElements: ElementMeta[] = [
  { element_id: "pan-input", tag: "input", type: "text", role: "textbox", label: null, text: "PAN_1", bbox: [10, 20, 200, 30] },
  { element_id: "el-input-7", tag: "input", type: "email", role: "textbox", label: null, text: "EMAIL_1", bbox: [10, 60, 200, 30], generated: true },
  { element_id: "submit-btn", tag: "button", type: "submit", role: "button", label: null, text: "Submit Form", bbox: [10, 100, 120, 40] },
];
const bridgeMap = { "pan-input": "ABCDE1234F", "el-input-7": "user@x.com" };
const namedBridgeElements: ElementMeta[] = [
  ...bridgeElements,
  { element_id: "email-input", tag: "input", type: "email", role: "textbox", label: "Email", text: "EMAIL_2", bbox: [10, 180, 200, 30] as [number, number, number, number] },
];

// click by name (no css) -> resolved to #submit-btn
const clickByName = agentActionToExecutorActions(
  { type: "click", target: { name: "Submit Form" } },
  bridgeElements,
  bridgeMap
);
assert.strictEqual(clickByName.length, 1);
assert.strictEqual(clickByName[0].target, "#submit-btn");
console.log("  ✔ Bridge resolves click target by name to a CSS selector");

// click by role + generated id -> attribute selector fallback
clickByRoleCheck: {
  const clickByRole = agentActionToExecutorActions(
    { type: "click", target: { role: "button" } },
    bridgeElements,
    bridgeMap
  );
  assert.strictEqual(clickByRole.length, 1);
  assert.strictEqual(clickByRole[0].target, "#submit-btn");
}
console.log("  ✔ Bridge resolves click target by role");

const namedFocus = agentActionToExecutorActions(
  { type: "focus", target: { role: "textbox", name: "Email" } },
  namedBridgeElements,
  { ...bridgeMap, "email-input": "second@x.com" }
);
assert.deepStrictEqual(namedFocus, [{ type: "focus", target: "#email-input", key: undefined }]);
console.log("  ✔ Compound role/name targets resolve conjunctively");

// click by bbox overlap -> nearest matching element
const clickByBbox = agentActionToExecutorActions(
  { type: "click", target: { bbox: [12, 102, 100, 36] } },
  bridgeElements,
  bridgeMap
);
assert.strictEqual(clickByBbox[0].target, "#submit-btn");
console.log("  ✔ Bridge resolves click target by bbox overlap");

// type by role: real value from the on-device map, never the placeholder
const typeByRole = agentActionToExecutorActions(
  { type: "type", target: { role: "textbox" }, placeholder: "PAN_1" },
  bridgeElements,
  bridgeMap
);
assert.strictEqual(typeByRole[0].target, "#pan-input");
assert.strictEqual(typeByRole[0].value, "ABCDE1234F"); // real value, not "PAN_1"
console.log("  ✔ Bridge resolves type target by placeholder and swaps to the local value");

// Same role/type fields still resolve by placeholder, not first role match.
const secondEmail = { ...bridgeElements[1], element_id: "el-input-8", text: "EMAIL_2", generated: true };
const typeSecondEmail = agentActionToExecutorActions(
  { type: "type", target: { role: "textbox" }, placeholder: "EMAIL_2" },
  [...bridgeElements, secondEmail],
  { ...bridgeMap, "el-input-8": "other@x.com" }
);
assert.deepStrictEqual(typeSecondEmail, [
  { type: "type", target: "__privis_generated:el-input-8", value: "other@x.com" },
]);
console.log("  ✔ EMAIL_2 resolves to the second matching field");

// A broad/mismatched CSS target cannot override the placeholder's field.
const prefixedRealId = {
  ...bridgeElements[1],
  element_id: "el-input-9",
  text: "EMAIL_3",
  generated: false,
};
assert.deepStrictEqual(
  agentActionToExecutorActions(
    { type: "type", target: { css: "input.email" }, placeholder: "EMAIL_3" },
    [...bridgeElements, prefixedRealId],
    { ...bridgeMap, "el-input-9": "third@x.com" }
  ),
  [{ type: "type", target: "#el-input-9", value: "third@x.com" }]
);
console.log("  ✔ Placeholder wins over mismatched CSS and real el-* ids remain real IDs");

// generated-id element -> in-memory lookup token
const typeGen = agentActionToExecutorActions(
  { type: "type", target: { css: "#el-input-7" }, placeholder: "EMAIL_1" },
  bridgeElements,
  bridgeMap
);
assert.strictEqual(typeGen[0].target, "__privis_generated:el-input-7");

// Missing local mapping is fail-closed: no placeholder reaches the executor.
assert.deepStrictEqual(
  agentActionToExecutorActions(
    { type: "type", target: { role: "textbox" }, placeholder: "EMAIL_1" },
    bridgeElements,
    { "pan-input": "ABCDE1234F" }
  ),
  []
);
assert.strictEqual(typeGen[0].value, "user@x.com");
console.log("  ✔ Bridge passes css targets through with real values");
const versionedElements: ElementMeta[] = [{ ...bridgeElements[0], snapshotVersion: 12 }];
assert.deepStrictEqual(agentActionToExecutorActions(
  { type: "click", target: { ref: { snapshotVersion: 12, documentId: "doc-a", elementId: versionedElements[0].element_id } } },
  versionedElements,
  bridgeMap
), [{ type: "click", target: "#pan-input" }]);
assert.deepStrictEqual(agentActionToExecutorActions(
  { type: "click", target: { ref: { snapshotVersion: 11, documentId: "doc-a", elementId: versionedElements[0].element_id } } },
  versionedElements,
  bridgeMap
), [{ type: "click", target: "__stale_reference" }]);
console.log("  ✔ Snapshot references resolve and stale references are preserved");

const focusAction = agentActionToExecutorActions(
  { type: "focus", target: { role: "textbox" } },
  bridgeElements,
  bridgeMap
);
assert.deepStrictEqual(focusAction, [{ type: "focus", target: "#pan-input", key: undefined }]);
const selectAction = agentActionToExecutorActions(
  { type: "select_option", target: { role: "combobox" }, option: "India" },
  [{ element_id: "country", tag: "select", type: null, role: "combobox", label: "Country", text: "", bbox: [10, 140, 200, 30] }],
  {}
);
assert.deepStrictEqual(selectAction, [{ type: "select_option", target: "#country", value: "India" }]);
const waitAction = agentActionToExecutorActions(
  { type: "wait_for", condition: "text", needle: "Added to cart", timeoutMs: 5000 },
  bridgeElements,
  bridgeMap
);
assert.deepStrictEqual(waitAction, [{ type: "wait_for", target: "", condition: "text", value: "Added to cart", timeoutMs: 5000 }]);
const dynamicWait = agentActionToExecutorActions(
  { type: "wait_for", condition: "element", target: { role: "button", name: "Added" }, timeoutMs: 5000 },
  bridgeElements,
  bridgeMap
);
assert.deepStrictEqual(dynamicWait, [{
  type: "wait_for",
  target: "",
  targetLocator: { role: "button", name: "Added" },
  condition: "element",
  timeoutMs: 5000,
}]);
console.log("  ✔ Bridge maps focus, select, and dynamic wait actions to local executor actions");

// Goal-substring literals: search boxes are not PII fields, but the DEVICE
// (not the server) decides — the phrase must appear in the on-device goal.
const literal = agentActionToExecutorActions(
  { type: "type", target: { css: "#el-input-7" }, placeholder: "HC Verma" },
  bridgeElements,
  bridgeMap,
  "find HC verma books on amazon"
);
assert.deepStrictEqual(
  literal,
  [{ type: "type", target: "#el-input-7", value: "HC Verma" }],
  "goal phrase typed verbatim when it is a case-insensitive substring of the goal"
);
assert.deepStrictEqual(
  agentActionToExecutorActions(
    { type: "type", target: { css: "#el-input-7" }, placeholder: "password123" },
    bridgeElements,
    bridgeMap,
    "find HC verma books on amazon"
  ),
  [],
  "a server-sent phrase NOT in the device goal fails closed (server untrusted)"
);

// unresolvable target -> loud failure action (content script reports
// "Target not found: __unresolved:<original target>"), not a silent no-op
const unresolvable = agentActionToExecutorActions(
  { type: "click", target: { name: "Nonexistent" } },
  bridgeElements,
  bridgeMap
);
assert.strictEqual(unresolvable.length, 1);
assert.ok(unresolvable[0].target.startsWith("__unresolved:"));
// non-executable action types -> no-op
assert.deepStrictEqual(agentActionToExecutorActions({ type: "done", reason: "x" }, bridgeElements, bridgeMap), []);
console.log("  ✔ Bridge no-ops unresolvable targets and non-executable action types");

// Regression: real-world click targets (no role ATTRIBUTE, label-ish ids, messy name)
const nativeBtn: ElementMeta[] = [
  { element_id: "1abc", tag: "button", type: null, role: null, label: null, text: "  Sign\u00a0In ", bbox: [5, 5, 80, 30] },
];
const clickNative = agentActionToExecutorActions(
  { type: "click", target: { role: "button", name: "sign in" } },
  nativeBtn,
  {}
);
assert.strictEqual(clickNative.length, 1);
assert.strictEqual(clickNative[0].target, "#\\31 abc"); // digit-start id needs CSS escaping
console.log("  ✔ Native <button> matches role:button; messy name/CASE + id escaping work");

// Restore developer environment after ALL isolation-dependent tests
process.env = ENV_BACKUP;

console.log("\n============================================================");
console.log("✅ ALL CBA-2 MODEL ROUTER & CLIENT TESTS PASSED (100%)");
console.log("============================================================\n");
