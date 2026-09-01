import type { BoundingBox, Viewport } from "../types/index.js";

/** ImageData/model boxes use source pixels; DOM boxes use viewport CSS pixels. */
export function imageToViewportBBox(
  bbox: BoundingBox,
  imageWidth: number,
  imageHeight: number,
  viewport: Viewport,
): BoundingBox {
  if (imageWidth <= 0 || imageHeight <= 0 || viewport.w <= 0 || viewport.h <= 0) {
    throw new Error("Cannot convert coordinates with non-positive dimensions");
  }
  return [
    bbox[0] * viewport.w / imageWidth,
    bbox[1] * viewport.h / imageHeight,
    bbox[2] * viewport.w / imageWidth,
    bbox[3] * viewport.h / imageHeight,
  ];
}

export function viewportToImageBBox(
  bbox: BoundingBox,
  viewport: Viewport,
  imageWidth: number,
  imageHeight: number,
): BoundingBox {
  if (viewport.w <= 0 || viewport.h <= 0 || imageWidth <= 0 || imageHeight <= 0) {
    throw new Error("Cannot convert coordinates with non-positive dimensions");
  }
  return [
    bbox[0] * imageWidth / viewport.w,
    bbox[1] * imageHeight / viewport.h,
    bbox[2] * imageWidth / viewport.w,
    bbox[3] * imageHeight / viewport.h,
  ];
}
