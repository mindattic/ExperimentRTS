/** A loaded real elevation map, resampled to a specific target resolution and reduced to a
 * single grayscale channel - see loadHeightmapImage(). */
export interface HeightmapImageData {
  width: number;
  height: number;
  /** One byte (0-255) per pixel, row-major, top row = north pole. */
  samples: Uint8ClampedArray;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load heightmap image: ${url}`));
    img.src = url;
  });
}

/**
 * Loads a real equirectangular elevation image and resamples it (via an offscreen canvas -
 * the browser's own image scaling does the down/up-sampling) to `targetWidth`x`targetHeight`,
 * returning a flat single-channel byte array for fast synchronous sampling later (see
 * PlanetHeightfield.useImage). Real elevation source photos occasionally carry real data-gap
 * artifacts (e.g. Venus's Magellan radar has unmapped polar streaks rendered as pure black) -
 * `minSample` softens the low end so a data gap reads as "low terrain" rather than a fake
 * bottomless canyon.
 */
export async function loadHeightmapImage(url: string, targetWidth: number, targetHeight: number, minSample = 0): Promise<HeightmapImageData> {
  const img = await loadImage(url);
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
  const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
  const src = imageData.data;

  const samples = new Uint8ClampedArray(targetWidth * targetHeight);
  for (let i = 0; i < samples.length; i++) {
    const r = src[i * 4];
    const g = src[i * 4 + 1];
    const b = src[i * 4 + 2];
    samples[i] = Math.max(minSample, (r + g + b) / 3);
  }
  return { width: targetWidth, height: targetHeight, samples };
}
