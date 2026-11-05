/* Separates the person from the background, so any photo works with no
   preparation. It runs in the visitor's browser: the photo is never uploaded
   to any server. Only used when config.js has no `mask`. */

const VERSION = '0.10.35';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

function centerConfidence(values, width, height) {
  let sum = 0;
  let count = 0;
  for (let y = Math.floor(height * 0.3); y < height * 0.6; y += 4) {
    for (let x = Math.floor(width * 0.35); x < width * 0.65; x += 4) {
      sum += values[y * width + x];
      count++;
    }
  }
  return count ? sum / count : 0;
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Cuts out the person. Returns a grayscale canvas, or throws an error. */
export async function detectPerson(source) {
  const { FilesetResolver, ImageSegmenter } = await import(`${CDN}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${CDN}/wasm`);
  const segmenter = await ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL },
    runningMode: 'IMAGE',
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });

  const result = segmenter.segment(source);
  const masks = result.confidenceMasks ?? [];
  if (!masks.length) throw new Error('The detector returned no mask');

  /* Depending on the model there is one mask or one per category: the person
     is whichever has the most confidence at the center of the image. */
  const { width, height } = masks[0];
  const candidates = masks.map((mask) => mask.getAsFloat32Array());
  const person = candidates.reduce((best, values) =>
    centerConfidence(values, width, height) > centerConfidence(best, width, height) ? values : best);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(width, height);
  for (let i = 0; i < person.length; i++) {
    const value = Math.round(smoothstep(0.3, 0.75, person[i]) * 255);
    image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = value;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);

  masks.forEach((mask) => mask.close());
  segmenter.close();
  return canvas;
}

/** Fallback when there is no mask or detector: a soft oval at the center. */
export function ovalMask(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = Math.round(256 * (height / width));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height * 0.46);
  ctx.scale(1, canvas.height / canvas.width);
  const radius = canvas.width * 0.56;
  const glow = ctx.createRadialGradient(0, 0, radius * 0.45, 0, 0, radius);
  glow.addColorStop(0, '#fff');
  glow.addColorStop(1, '#000');
  ctx.fillStyle = glow;
  ctx.fillRect(-canvas.width, -canvas.width, canvas.width * 2, canvas.width * 2);
  ctx.restore();
  return canvas;
}
