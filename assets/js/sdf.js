/* Glyph atlas stored as signed distance fields (SDF).
   Keeping the distance to each letter's edge, instead of the letter itself,
   allows two things: thickening or thinning it pixel by pixel in the shader
   (that is how the photo gets drawn) and magnifying it without pixelation. */

export const ATLAS = {
  cell: 64,       // side of each cell, in atlas pixels
  size: 40,       // font size inside the cell
  radius: 12,     // reach of the distance field
  cutoff: 0.25,   // value at the letter's true edge = 1 - cutoff
  originX: 12,    // where the letter starts inside the cell
  baseline: 46,   // baseline inside the cell
};

const INF = 1e20;

/* Euclidean distance transform (Felzenszwalb & Huttenlocher). */
function edt1d(grid, offset, stride, length, f, v, z) {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset];

  for (let q = 1, k = 0, s = 0; q < length; q++) {
    f[q] = grid[offset + q * stride];
    const q2 = q * q;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }

  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    const d = q - r;
    grid[offset + q * stride] = f[r] + d * d;
  }
}

function edt(grid, size, f, v, z) {
  for (let x = 0; x < size; x++) edt1d(grid, x, size, size, f, v, z);
  for (let y = 0; y < size; y++) edt1d(grid, y * size, 1, size, f, v, z);
}

/**
 * Draws each character and turns it into a distance field.
 * Returns the atlas (one channel), its grid and each letter's advance in em.
 */
export function buildAtlas(chars, font) {
  const { cell, size, radius, cutoff, originX, baseline } = ATLAS;
  const cols = Math.ceil(Math.sqrt(chars.length));
  const rows = Math.ceil(chars.length / cols);
  const width = cols * cell;
  const height = rows * cell;
  const pixels = new Uint8Array(width * height);

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = cell;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.font = `${font.weight} ${size}px ${font.family}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';

  const outer = new Float64Array(cell * cell);
  const inner = new Float64Array(cell * cell);
  const f = new Float64Array(cell);
  const v = new Uint16Array(cell);
  const z = new Float64Array(cell + 1);

  const glyphs = new Map();

  chars.forEach((char, index) => {
    ctx.clearRect(0, 0, cell, cell);
    ctx.fillText(char, originX, baseline);
    const { data } = ctx.getImageData(0, 0, cell, cell);

    for (let i = 0; i < cell * cell; i++) {
      const a = data[i * 4 + 3] / 255;
      if (a === 1) {
        outer[i] = 0;
        inner[i] = INF;
      } else if (a === 0) {
        outer[i] = INF;
        inner[i] = 0;
      } else {
        const d = 0.5 - a;
        outer[i] = d > 0 ? d * d : 0;
        inner[i] = d < 0 ? d * d : 0;
      }
    }

    edt(outer, cell, f, v, z);
    edt(inner, cell, f, v, z);

    const ox = (index % cols) * cell;
    const oy = Math.floor(index / cols) * cell;
    for (let y = 0; y < cell; y++) {
      for (let x = 0; x < cell; x++) {
        const i = y * cell + x;
        const d = Math.sqrt(outer[i]) - Math.sqrt(inner[i]);
        const value = 255 - 255 * (d / radius + cutoff);
        pixels[(oy + y) * width + ox + x] = Math.max(0, Math.min(255, Math.round(value)));
      }
    }

    glyphs.set(char, { index, advance: ctx.measureText(char).width / size });
  });

  return { pixels, width, height, cols, rows, glyphs };
}
