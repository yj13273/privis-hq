// privacy/sanitizer/visual-redact.ts
// Canvas-based visual redaction engine
//
// Responsibilities:
// - Takes in-memory screenshot data URL, sensitive bounding boxes, and viewport dimensions.
// - Masks/blackouts or pixelates sensitive regions on an OffscreenCanvas.
// - Returns sanitized image data URL (raw image is never emitted or retained).

import type { Detection, Viewport } from "../../types/index.js";

// Policy is explicit: credentials/cards/signatures/QR are blacked out, while
// faces/contact data use blur or pixelation to retain scene structure.
const BLACKOUT_CATEGORIES: ReadonlySet<Detection["category"]> = new Set([
  "PASSWORD",
  "PAN",
  "AADHAAR",
  "SIGNATURE",
  "QR",
]);

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type AnyContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(w, h);
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }
  // Fail closed: never return raw pixels when no canvas is available.
  throw new Error("redactVisual: no canvas available");
}

async function decodeImage(dataUrl: string): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    const blob = await (await fetch(dataUrl)).blob();
    return createImageBitmap(blob);
  }
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  return img;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function canvasToPngDataUrl(canvas: AnyCanvas): Promise<string> {
  const offscreen = canvas as OffscreenCanvas;
  if (typeof offscreen.convertToBlob === "function") {
    return blobToDataUrl(await offscreen.convertToBlob({ type: "image/png" }));
  }
  return (canvas as HTMLCanvasElement).toDataURL("image/png");
}

function get2dContext(canvas: AnyCanvas): AnyContext {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("redactVisual: 2d context unavailable");
  return ctx;
}

// Pixelate a region: shrink it to chunky tiles, then scale back up without smoothing.
function pixelate(
  ctx: AnyContext,
  src: CanvasImageSource,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const tilesX = Math.max(1, Math.round(w / 16));
  const tilesY = Math.max(1, Math.round(h / 16));
  const tiny = makeCanvas(tilesX, tilesY);
  const tinyCtx = get2dContext(tiny);
  tinyCtx.drawImage(src, x, y, w, h, 0, 0, tilesX, tilesY);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tiny, 0, 0, tilesX, tilesY, x, y, w, h);
}

function blur(ctx: AnyContext, src: CanvasImageSource, x: number, y: number, w: number, h: number): void {
  ctx.save();
  ctx.filter = "blur(12px)";
  ctx.drawImage(src, x, y, w, h, x, y, w, h);
  ctx.restore();
}

/**
 * Redacts sensitive bounding box regions on an in-memory image copy.
 * Returns a new PNG data URL; the input string is never mutated.
 * @param dataUrl Raw screenshot data URL
 * @param detections Sensitive detected regions
 * @param viewport Viewport dimensions for DPI scaling
 */
export async function redactVisual(
  dataUrl: string,
  detections: Detection[],
  viewport: Viewport
): Promise<string> {
  const img = await decodeImage(dataUrl);
  const canvas = makeCanvas(img.width, img.height);
  const ctx = get2dContext(canvas);
  ctx.drawImage(img, 0, 0);

  // bboxes are CSS pixels relative to the viewport; the screenshot is device pixels.
  const scaleX = viewport.w > 0 ? img.width / viewport.w : 1;
  const scaleY = viewport.h > 0 ? img.height / viewport.h : 1;

  for (const detection of detections) {
    const [bx, by, bw, bh] = detection.bbox;
    if (bw <= 0 || bh <= 0) continue; // ignore empty bboxes
    // Clamp the right/bottom edges too, so a bbox starting off-page doesn't
    // black out unrelated content inside the page (width/height shrink to fit).
    const x = Math.max(0, Math.round(bx * scaleX));
    const y = Math.max(0, Math.round(by * scaleY));
    const right = Math.min(canvas.width, Math.round((bx + bw) * scaleX));
    const bottom = Math.min(canvas.height, Math.round((by + bh) * scaleY));
    const w = right - x;
    const h = bottom - y;
    if (w <= 0 || h <= 0) continue;

    if (detection.category === "FACE" || detection.category === "EMAIL" || detection.category === "PHONE" || detection.category === "NAME" || detection.category === "ORG") {
      blur(ctx, canvas, x, y, w, h);
    } else if (detection.category === "OCR_TEXT") {
      pixelate(ctx, canvas, x, y, w, h);
    } else if (BLACKOUT_CATEGORIES.has(detection.category)) {
      ctx.fillStyle = "#000";
      ctx.fillRect(x, y, w, h);
    }
  }

  return canvasToPngDataUrl(canvas);
}
