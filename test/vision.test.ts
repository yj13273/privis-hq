import QRCode from "qrcode";
import { QrDetector } from "../privacy/engine/qr-detector.js";
import { FaceDetector } from "../privacy/engine/face-detector.js";
import type { VisionFrame } from "../privacy/engine/vision-detector.js";

async function runVisionFixture(): Promise<void> {
  const qrCanvas = document.querySelector<HTMLCanvasElement>("#qr");
  const faceImage = document.querySelector<HTMLImageElement>("#face");
  const output = document.querySelector("#output");
  if (!qrCanvas || !faceImage || !output) throw new Error("Vision fixture elements unavailable");
  await QRCode.toCanvas(qrCanvas, "PRIVIS-SYNTHETIC-QR", { width: 320, margin: 2 });
  if (!faceImage.complete) await new Promise<void>((resolve, reject) => {
    faceImage.addEventListener("load", () => resolve(), { once: true });
    faceImage.addEventListener("error", () => reject(new Error("Face fixture image failed to load")), { once: true });
  });
  const qrFrame: VisionFrame = { image: qrCanvas, width: qrCanvas.width, height: qrCanvas.height, viewport: { w: qrCanvas.clientWidth || 320, h: qrCanvas.clientHeight || 320 } };
  const faceFrame: VisionFrame = { image: faceImage, width: faceImage.naturalWidth, height: faceImage.naturalHeight, viewport: { w: faceImage.clientWidth || faceImage.naturalWidth, h: faceImage.clientHeight || faceImage.naturalHeight } };
  const qr = new QrDetector();
  const face = new FaceDetector();
  const qrResult = await qr.detect(qrFrame);
  const faceResult = await face.detect(faceFrame);
  const safeResult = {
    qrDetections: qrResult.detections.map(({ bbox, confidence, category, source }) => ({ bbox, confidence, category, source })),
    faceDetections: faceResult.detections.map(({ bbox, confidence, category, source }) => ({ bbox, confidence, category, source })),
    qrDiagnostics: qrResult.diagnostics,
    faceDiagnostics: faceResult.diagnostics,
    barcode: { available: false, reason: "jsQR is QR-only; no linear barcode decoder installed" },
  };
  output.textContent = JSON.stringify(safeResult, null, 2);
  console.log("Vision diagnostics and detections:", safeResult);
  console.assert(qrResult.detections.length === 1, "Real QR fixture was not detected");
  console.assert(qrResult.detections[0]?.bbox.every((value) => value > 0), "QR bbox is invalid");
  if (faceResult.diagnostics.available) {
    console.assert(faceResult.detections.every((d) => d.bbox[2] > 0 && d.bbox[3] > 0), "Face bbox is invalid");
  }
  await Promise.all([qr.dispose(), face.dispose()]);
}

void runVisionFixture().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  document.querySelector("#output")!.textContent = JSON.stringify({ error: message });
  console.error("Vision fixture failed:", message);
});
