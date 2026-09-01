import { TesseractOcrDetector } from "../privacy/engine/ocr-detector.js";
import { detectOcrPii } from "../privacy/sanitizer/structural-redact.js";
import type { VisionFrame } from "../privacy/engine/vision-detector.js";

async function runOcrFixture(): Promise<void> {
const canvas = document.createElement("canvas");
canvas.width = 1400;
canvas.height = 520;
canvas.style.width = "700px";
canvas.style.height = "260px";
document.body.appendChild(canvas);
const context = canvas.getContext("2d");
if (!context) throw new Error("OCR fixture canvas unavailable");
context.fillStyle = "#fff";
context.fillRect(0, 0, canvas.width, canvas.height);
context.fillStyle = "#000";
context.font = "bold 46px Arial";
context.fillText("Email: john@example.com", 40, 110);
context.fillText("Phone: +91 9876543210", 40, 220);
context.fillText("Card: 4111 1111 1111 1111", 40, 330);
context.fillText("Ordinary webpage text", 40, 440);

const fixture: VisionFrame = {
  image: canvas,
  width: canvas.width,
  height: canvas.height,
  viewport: { w: canvas.clientWidth || 700, h: canvas.clientHeight || 260 },
};
const output = document.querySelector("#output")!;
const detector = new TesseractOcrDetector({
  workerOptions: {
    logger: () => undefined,
    workerPath: new URL("../node_modules/tesseract.js/dist/worker.min.js", location.href).href,
    corePath: new URL("../node_modules/tesseract.js-core", location.href).href,
    langPath: new URL("../node_modules/@tesseract.js-data/eng/4.0.0_best_int", location.href).href,
    workerBlobURL: false,
  },
});
const started = performance.now();
const result = await detector.detect(fixture);
const ocrPii = detectOcrPii(result.detections);
const elapsedMs = performance.now() - started;
const diagnostics = detector.getInitializationDiagnostics();
const safeResult = {
  ocrWordCount: result.detections.length,
  ocrPiiCount: ocrPii.length,
  piiReasons: ocrPii.map((d) => d.metadata?.reason),
  boxesHaveCoordinates: result.detections.every((d) => d.bbox[2] > 0 && d.bbox[3] > 0),
  diagnostics,
  inferenceLatencyMs: result.diagnostics.latencyMs,
  totalLatencyMs: elapsedMs,
};
output.textContent = JSON.stringify(safeResult, null, 2);
console.log("OCR diagnostics and counts:", safeResult);
console.assert(result.detections.length > 0, "Tesseract returned no words for the rendered fixture");
console.assert(safeResult.boxesHaveCoordinates, "OCR returned an invalid bounding box");
console.assert(!JSON.stringify(safeResult).includes("john@example.com"), "Sensitive OCR text leaked into diagnostics");
await detector.dispose();
}

void runOcrFixture().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  document.querySelector("#output")!.textContent = JSON.stringify({ error: message });
  console.error("OCR fixture failed:", message);
});
