/** Converts the existing VisionFrame image forms into ImageData for local models. */
export async function imageToImageData(
  image: string | ImageData | HTMLCanvasElement | ImageBitmap | HTMLImageElement,
): Promise<ImageData> {
  if (image instanceof ImageData) return image;
  const canvas = document.createElement("canvas");
  let source: CanvasImageSource;
  if (typeof image === "string") {
    const bitmap = await createImageBitmap(await (await fetch(image)).blob());
    source = bitmap;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
  } else {
    source = image;
    const imageElement = image as HTMLImageElement;
    canvas.width = image instanceof HTMLImageElement ? imageElement.naturalWidth : image.width;
    canvas.height = image instanceof HTMLImageElement ? imageElement.naturalHeight : image.height;
  }
  if (!canvas.width || !canvas.height) throw new Error("Image source has no dimensions");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Unable to create image conversion context");
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}
