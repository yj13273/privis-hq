// privacy/sanitizer/structural-redact.ts
// DOM detection rules and structural placeholder replacement
//
// Responsibilities:
// - Identifies sensitive categories (PAN, Aadhaar, Email, Phone, Amount, Password, Name).
// - Emits detection metadata with bounding boxes and confidence scores.
// - Substitutes real values with stable tokens (e.g. EMAIL_1, PAN_1).
// - Isolates real values in a local lookup map (never emitted upstream).

import type { Detection, ElementMeta, SensitiveCategory } from "../../types/index.js";

export const CATEGORIES: SensitiveCategory[] = [
  "EMAIL",
  "PAN",
  "AADHAAR",
  "AMOUNT",
  "PHONE",
  "NAME",
  "FACE",
  "PASSWORD",
];

// Confidence: 0.95 for regex / input[type] hits, 0.7 for label-only hits.
const CONFIDENCE_HIT = 0.95;
const CONFIDENCE_LABEL = 0.7;

const PAN_RE = /[A-Z]{5}[0-9]{4}[A-Z]/;
const EMAIL_RE = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/;
const CREDIT_CARD_RE = /(?:\d[ -]*?){13,19}/;
const OCR_EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/i;
const OCR_PHONE_RE = /\+91[\s.-]?[6-9]\d{4}[\s.-]?\d{5}/;
// Indian mobile: optional +91 country code, starts 6-9, 10 digits total.
const PHONE_RE = /^(\+91)?[6-9][0-9]{9}$/;
// Currency symbol / currency unit in value text.
const AMOUNT_TEXT_RE = /[₹$€£]|\b(?:inr|rs\.?)\b/i;

// Label-only fallbacks are restricted to the documented password / amount / name
// rules; PAN, phone, Aadhaar, and email are only detected from strong regex/type
// evidence, never from a bare label.
const PASSWORD_LABEL_RE = /otp|password/i;
const AMOUNT_LABEL_RE = /salary|amount|ctc|reimbursement|inr|₹|rs\.?/i;
const NAME_LABEL_RE = /name/i;

// "2341 5678 9012" -> "234156789012", so grouped Aadhaar still matches.
function compactDigits(s: string): string {
  return s.replace(/[\s-]/g, "");
}

function luhnValid(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (alternate) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

/**
 * Detects a single sensitive entity in one element, or null when nothing matches.
 * Stronger (regex/type) signals win over label-only hits.
 */
function detectElement(
  el: ElementMeta
): { category: SensitiveCategory; confidence: number } | null {
  const tag = (el.tag ?? "").toLowerCase();
  const role = (el.role ?? "").toLowerCase();
  const label = (el.label ?? "").trim();
  const type = (el.type ?? "").toLowerCase();
  const autocomplete = (el.autocomplete ?? "").toLowerCase();
  const text = el.text.trim();
  const compact = compactDigits(text);

  // Buttons are CTAs, not data fields: skip so a label like "Pay ₹100" isn't
  // treated as AMOUNT and its whole label replaced with a placeholder.
  if (tag === "button" || role === "button") return null;

  // Pass 1: strong regex / input-type hits only. These always win, regardless
  // of any label, so "Phone" with an email value is EMAIL, not PHONE.
  // PHONE before AADHAAR so "+91 98765 43210" isn't read as 12 digits.
  if (type === "password") return { category: "PASSWORD", confidence: CONFIDENCE_HIT };
  if (["cc-number", "cc-csc", "cc-exp"].includes(autocomplete)) {
    return { category: autocomplete === "cc-number" ? "PAN" : "PASSWORD", confidence: CONFIDENCE_HIT };
  }
  if (PAN_RE.test(text.toUpperCase())) return { category: "PAN", confidence: CONFIDENCE_HIT };
  if (PHONE_RE.test(compact)) return { category: "PHONE", confidence: CONFIDENCE_HIT };
  if (/^[0-9]{12}$/.test(compact)) return { category: "AADHAAR", confidence: CONFIDENCE_HIT };
  if (type === "email" || EMAIL_RE.test(text)) return { category: "EMAIL", confidence: CONFIDENCE_HIT };
  if (AMOUNT_TEXT_RE.test(text)) return { category: "AMOUNT", confidence: CONFIDENCE_HIT };
  const cardMatch = text.match(CREDIT_CARD_RE);
  if (cardMatch && luhnValid(cardMatch[0])) return { category: "PAN", confidence: CONFIDENCE_HIT };

  // Pass 2: label-only fallbacks (0.7) — documented password / amount / name.
  if (PASSWORD_LABEL_RE.test(label)) return { category: "PASSWORD", confidence: CONFIDENCE_LABEL };
  if (AMOUNT_LABEL_RE.test(label)) return { category: "AMOUNT", confidence: CONFIDENCE_LABEL };
  if (NAME_LABEL_RE.test(label)) return { category: "NAME", confidence: CONFIDENCE_LABEL };

  return null;
}

/**
 * Detects sensitive entities in extracted DOM element metadata.
 * @param elements Extracted DOM element metadata
 */
export function detectSensitive(elements: ElementMeta[]): Detection[] {
  const detections: Detection[] = [];
  for (const el of elements) {
    const hit = detectElement(el);
    if (hit) {
      detections.push({
        element_id: el.element_id,
        category: hit.category,
        bbox: el.bbox,
        confidence: hit.confidence,
        source: "dom",
        metadata: { reason: hit.category === "PAN" && /cc-number|credit/i.test(`${el.autocomplete ?? ""} ${el.label ?? ""} ${el.text}`) ? "credit_card" : "sensitive_input" },
      });
    }
  }
  return detections;
}

/** Detects PII in visible text nodes without exposing text in the Detection shape. */
export function detectVisibleTextPii(root: Document = document): Detection[] {
  const out: Detection[] = [];
  const seen = new Set<string>();
  const walker = root.createTreeWalker(root.body ?? root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  let index = 0;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || !isVisibleTextParent(parent)) continue;
    const text = node.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const range = root.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const bbox: ElementMeta["bbox"] = [rect.left, rect.top, rect.width, rect.height];
    const element_id = `text-${++index}`;
    const add = (category: SensitiveCategory, reason: string, match: string) => out.push({
      element_id, category, bbox, confidence: 0.95, source: "dom", metadata: { reason, text: match },
    });
    const email = text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/i);
    if (email) add("EMAIL", "email", email[0]);
    const phone = text.match(/\+91[\s.-]?[6-9]\d{4}[\s.-]?\d{5}/);
    if (phone) add("PHONE", "phone", phone[0]);
    const card = text.match(CREDIT_CARD_RE);
    if (card && luhnValid(card[0])) add("PAN", "credit_card", card[0]);
  }
  return out;
}

/** Maps local OCR tokens to PII boxes without losing their image-derived coordinates. */
export function detectOcrPii(
  tokens: Array<{ element_id?: string; bbox: ElementMeta["bbox"]; metadata?: { text?: string } }>,
): Detection[] {
  const out: Detection[] = [];
  const lines: typeof tokens[] = [];
  for (const token of tokens.filter((item) => item.metadata?.text?.trim() && item.bbox[2] > 0 && item.bbox[3] > 0)) {
    const centerY = token.bbox[1] + token.bbox[3] / 2;
    const line = lines.find((candidate) => {
      const candidateTop = Math.min(...candidate.map((item) => item.bbox[1]));
      const candidateBottom = Math.max(...candidate.map((item) => item.bbox[1] + item.bbox[3]));
      const candidateHeight = Math.max(...candidate.map((item) => item.bbox[3]));
      return centerY >= candidateTop - candidateHeight * 0.5 && centerY <= candidateBottom + candidateHeight * 0.5;
    });
    if (line) line.push(token);
    else lines.push([token]);
  }
  for (const line of lines) {
    line.sort((a, b) => a.bbox[0] - b.bbox[0]);
    const text = line.map((token) => token.metadata?.text?.trim()).filter(Boolean).join(" ");
    const bbox: ElementMeta["bbox"] = [
      Math.min(...line.map((token) => token.bbox[0])),
      Math.min(...line.map((token) => token.bbox[1])),
      Math.max(...line.map((token) => token.bbox[0] + token.bbox[2])) - Math.min(...line.map((token) => token.bbox[0])),
      Math.max(...line.map((token) => token.bbox[1] + token.bbox[3])) - Math.min(...line.map((token) => token.bbox[1])),
    ];
    const add = (category: SensitiveCategory, reason: string, match: string) => out.push({
      element_id: line[0].element_id ?? `ocr-pii-${out.length + 1}`,
      category,
      bbox,
      confidence: 0.9,
      source: "vision",
      metadata: { reason, text: match, sourceRule: "ocr+regex" },
    });
    const email = text.match(OCR_EMAIL_RE);
    if (email) add("EMAIL", "email", email[0]);
    const phone = text.match(OCR_PHONE_RE);
    if (phone) add("PHONE", "phone", phone[0]);
    const card = text.match(CREDIT_CARD_RE);
    if (card && luhnValid(card[0])) add("PAN", "credit_card", card[0]);
  }
  return out;
}

function isVisibleTextParent(element: Element): boolean {
  if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(element.tagName)) return false;
  if ((element as HTMLElement).hidden || element.getAttribute("aria-hidden") === "true") return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// Session-stable tokens: the same real value always maps to the same placeholder
// (user@x.com is EMAIL_1 every step), and counters start per category.
const tokenByValue = new Map<string, string>();
const nextIndex: Record<string, number> = {};

function tokenFor(category: SensitiveCategory, value: string): string {
  const key = `${category}\u0000${value}`;
  let token = tokenByValue.get(key);
  if (!token) {
    const n = (nextIndex[category] = (nextIndex[category] ?? 0) + 1);
    token = `${category}_${n}`;
    tokenByValue.set(key, token);
  }
  return token;
}

/**
 * Replaces sensitive values with stable placeholders and builds local mapping.
 * @param elements Extracted DOM element metadata
 * @param detections Detected sensitive entities
 */
export function applyPlaceholders(
  elements: ElementMeta[],
  detections: Detection[]
): { sanitized: ElementMeta[]; map: Record<string, string> } {
  const byId = new Map<string, Detection>();
  for (const d of detections) byId.set(d.element_id, d);

  const sanitized: ElementMeta[] = [];
  const map: Record<string, string> = {};

  for (const el of elements) {
    const d = byId.get(el.element_id);
    const text = el.text.trim();
    let out = el;
    if (d && text) {
      if (d.category === "PASSWORD") {
        // Password value is never extracted; redacted by input type, no placeholder.
        out = { ...el, text: "" };
      } else if (d.category === "FACE") {
        // Face is redacted as pixels only; never placeholder-swapped or text-blanked.
        out = el;
      } else {
        map[el.element_id] = el.text; // real value stays local, never sent to remote
        out = { ...el, text: tokenFor(d.category, el.text) };
      }
    }
    sanitized.push(out);
  }
  return { sanitized, map };
}
