/* The living portrait.

   The whole screen is a flowing wall of text. Each letter is a small quad
   drawn on the GPU, and its weight is decided pixel by pixel from the
   brightness of the photo underneath: where the photo is bright the
   letters get heavier and glow, where it is dark they thin out. The image
   is not painted anywhere, it only appears in the weight of the text
   (a halftone made of typography). */

import { ATLAS, buildAtlas } from './sdf.js';

const MARGIN = 56;              // spare text on each side, so the flow never shows a seam
const FLOW_SPEED = 9;           // pixels per second
const LENS_POWER = 0.95;        // lens magnification (1 + this, at the center)
const FADE_SECONDS = 2;         // how long a song change takes
const ASSEMBLE_SECONDS = 4.2;   // how long the portrait takes to assemble on open
const SEPARATOR = ' / ';        // between verses, the way poems are quoted

const CELL_EM = ATLAS.cell / ATLAS.size;
const ORIGIN_EM = [ATLAS.originX / ATLAS.size, ATLAS.baseline / ATLAS.size];
const EDGE_VALUE = 1 - ATLAS.cutoff;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const hexToRgb = (hex) => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
};

/* ───────────────────────────── Shaders ───────────────────────────── */

const COMMON = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

float luma(vec3 c) { return dot(c, vec3(.299, .587, .114)); }

/* The photo melts away at its edges so there is no straight cut. */
float rectFade(vec2 uv) {
  return smoothstep(0., .13, uv.x) * smoothstep(1., .87, uv.x)
       * smoothstep(0., .02, uv.y) * smoothstep(1., .9, uv.y);
}
`;

const BACKDROP_VERT = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2. - 1., 0., 1.);
}`;

const BACKDROP_FRAG = COMMON + /* glsl */ `
uniform vec2 uRes;
uniform float uDpr, uTime, uReveal, uDim, uOpen, uLensR, uAssemble;
uniform vec4 uRect;
uniform vec2 uHead;
uniform vec3 uBase, uGlow, uPointer;
uniform sampler2D uPhoto, uMask;
out vec4 outColor;

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * .1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y * uDpr - gl_FragCoord.y) / uDpr;
  vec2 uv = (p - uRect.xy) / uRect.zw;
  vec2 cuv = clamp(uv, 0., 1.);
  float mask = texture(uMask, cuv).r * rectFade(uv);

  /* A light behind the head: it cuts the silhouette out of the background. */
  vec2 d = (p - uHead) / (uRect.z * vec2(.82, 1.02));
  float halo = exp(-dot(d, d) * 1.7);
  float breathe = .92 + .08 * sin(uTime * .55);
  float glow = halo * halo;
  vec3 color = uBase * (.16 + .6 * halo) + uGlow * glow * .15 * breathe;

  /* The silhouette blocks the light, and under the letters sits a soft, dim
     copy of the photo: that is what gives skin its continuous tone. */
  vec3 soft = textureLod(uPhoto, cuv, 1.2).rgb;
  float softLuma = luma(soft);
  soft = mix(softLuma * (uGlow * .7 + .45), soft, .62);

  /* At first only the silhouette shows: the photo arrives with the letters. */
  float arrived = smoothstep(.3, .92, uAssemble);
  color = mix(color, soft * mix(.3, .68, smoothstep(.2, .75, softLuma)) * arrived + uBase * .08, mask);
  color *= mix(.3, 1., uDim) * uOpen;

  /* Under the lens the background gives way, so the letters stay readable. */
  float lens = uPointer.z * smoothstep(1., .35, length(p - uPointer.xy) / uLensR);
  color *= 1. - .72 * lens;

  /* The real photo, for the ending. */
  vec3 photo = texture(uPhoto, cuv).rgb;
  photo = mix(vec3(luma(photo)), photo, 1.06);
  photo = smoothstep(vec3(-.02), vec3(1.), photo);

  /* The photo falls into shadow near its outline, which hides the cutout. */
  float inner = textureLod(uMask, cuv, 3.6).r;
  photo *= mix(.22, 1., smoothstep(.42, .92, inner));
  color = mix(color, photo, uReveal * mask);

  /* Vignette plus a touch of grain, which also prevents banding. */
  vec2 v = (p / uRes - .5) * vec2(1.1, 1.);
  color *= 1. - .5 * smoothstep(.35, .95, length(v));
  color += (hash(p + fract(uTime) * 91.7) - .5) * .014;

  outColor = vec4(color, 1.);
}`;

const GLYPH_VERT = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aGlyph;   // x, baseline, atlas index, verse
layout(location = 2) in vec2 aMeta;    // random, advance

uniform vec2 uRes, uGrid, uHead, uOriginEm;
uniform float uFont, uCellEm, uFlow, uRowLen, uMargin, uTime;
uniform vec3 uPointer;                 // x, y, strength
uniform float uLensR, uLensPower;
uniform float uPresence, uLeaving, uAssemble, uScatter;
uniform float uActiveLine, uHot;

out vec2 vAtlas;
out vec2 vSource;
out float vLens;
out float vHot;
out float vAlive;

mat2 rotate(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

void main() {
  /* Each row flows at a slightly different pace, so the text feels woven. */
  float rowDrift = 1. + .22 * sin(aGlyph.y * 1.37);
  float x = mod(aGlyph.x - uFlow * rowDrift, uRowLen) - uMargin;
  vec2 origin = vec2(x, aGlyph.y);
  vec2 center = origin + vec2(aMeta.y * .5, -uFont * .34);

  /* The quad only covers the letter's ink, not the whole atlas cell. */
  vec2 inCell = mix(vec2(.1, .12), vec2(.92), aCorner);
  vec2 corner = origin + (inCell * uCellEm - uOriginEm) * uFont;

  /* Order of appearance: from the face outward, with some randomness. */
  float far = clamp(length(center - uHead) / length(uRes) * 1.5, 0., 1.);
  float order = far * .82 + aMeta.x * .18;

  /* Song change: a wave born at the face, on the way out as well. */
  float wave = uLeaving > .5 ? 1. - order : order;
  float alive = smoothstep(wave * .6, wave * .6 + .4, uPresence);

  /* Opening: the letters drift down into place. */
  float settle = smoothstep(order * .66, order * .66 + .34, uAssemble);
  float eased = 1. - pow(1. - settle, 3.);
  vec2 fall = vec2((aMeta.x - .5) * 200., -220. - fract(aMeta.x * 5.3) * 380.) * (1. - eased);
  float spin = (1. - eased) * (fract(aMeta.x * 7.31) - .5) * 5.;
  alive *= smoothstep(0., .3, settle);

  /* Ending: the letters lift away like ash. */
  float gone = smoothstep(order * .5, order * .5 + .5, uScatter);
  vec2 lift = vec2(sin(aMeta.x * 43. + uTime * .5) * 50., -130. - fract(aMeta.x * 3.7) * 260.) * gone * gone;
  alive *= 1. - gone;

  /* Lens: magnifies at the center and eases back to 1 at the edge, so no
     ring shows, just text bulging under the cursor. */
  float scale = 1.;
  vec2 lensCenter = center;
  float lens = 0.;
  if (uPointer.z > .002) {
    vec2 toGlyph = center - uPointer.xy;
    float t = length(toGlyph) / uLensR;
    if (t < 1.) {
      float k = uPointer.z * uLensPower;
      float falloff = 1. - t * t;
      lensCenter = uPointer.xy + toGlyph * (1. + k * falloff * falloff);
      scale = clamp(1. + k * falloff * (1. - 5. * t * t), .6, 3.);
      lens = uPointer.z * smoothstep(1., .42, t);
      /* Letters pile up at the edge: fade them so they don't form a ring. */
      alive *= 1. - .7 * uPointer.z * smoothstep(.5, .78, t) * smoothstep(1., .9, t);
    }
  }

  vec2 rel = rotate(spin) * (corner - center) * scale;
  vec2 pos = lensCenter + rel + fall + lift;

  vec2 clip = pos / uRes * 2. - 1.;
  gl_Position = vec4(clip.x, -clip.y, 0., 1.);

  float index = aGlyph.z;
  float row = floor((index + .5) / uGrid.x);
  vec2 cell = vec2(index - row * uGrid.x, row);
  vAtlas = (cell + inCell) / uGrid;
  vSource = corner;
  vLens = lens;
  vHot = uHot * step(abs(aGlyph.w - uActiveLine), .5);
  vAlive = alive;
}`;

const GLYPH_FRAG = COMMON + /* glsl */ `
in vec2 vAtlas;
in vec2 vSource;
in float vLens;
in float vHot;
in float vAlive;

uniform sampler2D uAtlas, uPhoto, uMask;
uniform vec4 uRect;
uniform vec2 uLevels, uHead;
uniform vec3 uShadow, uMid, uLight;
uniform float uDim, uEdge, uTime;

out vec4 outColor;

vec3 ramp(float t) {
  return t < .5 ? mix(uShadow, uMid, t * 2.) : mix(uMid, uLight, t * 2. - 1.);
}

void main() {
  /* Most of each quad is empty: discard it here, before reading the photo.
     This is what lets a phone move so many letters. */
  float dist = texture(uAtlas, vAtlas, -.5).r;
  float aa = max(fwidth(dist) * .75, .012);
  if (vAlive < .003 || dist < .5 - aa) discard;

  vec2 uv = (vSource - uRect.xy) / uRect.zw;
  vec2 cuv = clamp(uv, 0., 1.);
  float mask = textureLod(uMask, cuv, 0.).r * rectFade(uv);

  /* Photo tone, with local contrast so the details come through. */
  vec3 photo = textureLod(uPhoto, cuv, .4).rgb;
  float near = luma(textureLod(uPhoto, cuv, 2.5).rgb);
  float wide = luma(textureLod(uPhoto, cuv, 5.).rgb);
  float l = luma(photo);
  float tone = clamp(l + (l - near) * .6 + (near - wide) * .18, 0., 1.);
  tone = clamp((tone - uLevels.x) / (uLevels.y - uLevels.x), 0., 1.);
  tone = mix(.07, 1., pow(tone, .78));

  /* Outside the person, the text is barely a texture under the light. */
  vec2 d = (vSource - uHead) / (uRect.z * vec2(.82, 1.02));
  float halo = exp(-dot(d, d) * 1.7);
  float backdrop = .02 + .15 * halo * halo;
  float t = mix(backdrop, tone, mask);

  /* Anything with real color (red lips, for example) stays lit and keeps
     that color in every palette. */
  float high = max(photo.r, max(photo.g, photo.b));
  float low = min(photo.r, min(photo.g, photo.b));
  float vivid = mask * smoothstep(.3, .46, high - low);
  t = mix(t, max(t, .66), vivid);

  /* Under the lens the text brightens just enough to read, while still
     being the face. */
  t = mix(t, max(t, .58), vLens);

  /* The verse being read lights up only over the figure and its glow,
     never under the text column. */
  float hot = vHot * max(mask, smoothstep(.2, .7, halo) * .5) * smoothstep(.3, .6, uDim);

  /* The halftone: brightness decides how heavy each stroke gets. */
  float weight = mix(uEdge + .08, .5, t);
  weight = mix(weight, uEdge - .06, max(hot, vLens * .8));

  float alpha = smoothstep(weight - aa, weight + aa, dist);

  /* Color: the song's palette, with a touch of the real color. */
  vec3 color = ramp(t);
  vec3 real = mix(vec3(l), photo, 1.45) * 1.5;
  color = mix(color, real, mask * .16 + vivid * .78);
  color *= mix(.62, 1.1, t);

  color = mix(color, uLight * 1.15, hot * .72);
  color *= mix(mix(.26, 1., uDim), 1., max(hot, vLens));

  float a = alpha * vAlive;
  outColor = vec4(color * a, a);
}`;

/* ──────────────────────────── WebGL helpers ──────────────────────────── */

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

function createProgram(gl, vertex, fragment) {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program));
  }
  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const { name } = gl.getActiveUniform(program, i);
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return { program, uniforms };
}

function createTexture(gl, source) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.generateMipmap(gl.TEXTURE_2D);
  return texture;
}

/* ───────────────────────────── The portrait ───────────────────────────── */

export class Portrait {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} scene
   * @param {HTMLCanvasElement} scene.photo  photo, already oriented
   * @param {HTMLCanvasElement} scene.mask   white = person
   * @param {{focus:{x:number,y:number}, levels:number[]}} scene.analysis
   * @param {{lines:string[], palette:string[]}[]} scene.songs
   * @param {{family:string, weight:number}} scene.font
   * @param {{uppercase:boolean, density:number, flow:number}} scene.options
   */
  constructor(canvas, scene) {
    this.canvas = canvas;
    this.scene = scene;
    this.options = scene.options;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.songs = scene.songs.map((song) => ({
      ...song,
      colors: song.palette.map(hexToRgb),
      presence: 0,
      target: 0,
      leaving: false,
    }));
    this.current = 0;
    this.songs[0].target = 1;
    this.songs[0].presence = 1;

    this.time = 0;
    this.flow = 0;
    this.assemble = this.reduced ? 1 : 0;
    this.open = this.reduced ? 1 : 0;
    this.reveal = 0;
    this.scatter = 0;
    this.dim = 1;
    this.dimTarget = 1;
    this.activeLine = -1;
    this.hot = 0;
    this.pointer = { x: 0, y: 0, tx: 0, ty: 0, strength: 0, target: 0 };

    this.gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      powerPreference: 'high-performance',
    });
    if (!this.gl) throw new Error('WebGL2 is not available');

    this._prepareText();
    this._initGL();
    this._resize(true);

    new ResizeObserver(() => this._resize()).observe(canvas);
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      cancelAnimationFrame(this.raf);
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this._initGL();
      this._resize(true);
      this.start();
    });
  }

  /* What the rest of the page sees */

  /** The photo's rectangle on screen, in CSS pixels. */
  get rect() { return this._rect; }

  setSong(index) {
    if (index === this.current) return;
    this.songs.forEach((song, i) => {
      song.target = i === index ? 1 : 0;
      song.leaving = i !== index;
    });
    this.current = index;
  }

  setActiveLine(line) {
    if (line === this.activeLine) return;
    this.activeLine = line;
    this.hot = 0;
  }

  setDim(value) { this.dimTarget = value; }

  /** 0 = letters, 1 = the real photo. */
  setReveal(value) {
    this.reveal = clamp(value, 0, 1);
    this.scatter = clamp(value * 1.15, 0, 1);
  }

  setPointer(x, y, active) {
    const { pointer } = this;
    if (active && pointer.strength < 0.02) {
      pointer.x = x;
      pointer.y = y;
    }
    pointer.tx = x;
    pointer.ty = y;
    pointer.target = active ? 1 : 0;
  }

  start() {
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this._loop);
  }

  /* Text */

  _prepareText() {
    const { uppercase } = this.options;
    const seen = new Set();

    this.songs.forEach((song) => {
      const stream = [];
      song.lines.forEach((text, line) => {
        const shown = uppercase ? text.toLocaleUpperCase() : text;
        for (const char of `${shown}${SEPARATOR}`) {
          stream.push({ char, line });
          if (char !== ' ') seen.add(char);
        }
      });
      song.stream = stream;
    });

    this.atlas = buildAtlas([...seen, ' '], this.scene.font);
  }

  _layoutSong(song, seed) {
    const { font, rowHeight, width, height, tracking } = this.metrics;
    const { glyphs } = this.atlas;
    const rowLength = width + MARGIN * 2;
    const rows = Math.ceil(height / rowHeight) + 3;
    const { stream } = song;

    const data = [];
    let cursor = Math.floor(seed * stream.length);

    for (let row = 0; row < rows; row++) {
      const y = (row - 0.5) * rowHeight;
      let x = 0;
      while (x < rowLength) {
        const { char, line } = stream[cursor % stream.length];
        cursor++;
        const glyph = glyphs.get(char);
        const advance = glyph.advance * font + tracking;
        if (char !== ' ') {
          data.push(x, y, glyph.index, line, Math.random(), advance);
        }
        x += advance;
      }
    }
    return new Float32Array(data);
  }

  _buildGeometry() {
    const { gl } = this;
    this.songs.forEach((song, index) => {
      const data = this._layoutSong(song, index * 0.37);
      song.count = data.length / 6;

      if (song.vao) {
        gl.deleteVertexArray(song.vao);
        gl.deleteBuffer(song.buffer);
      }
      song.vao = gl.createVertexArray();
      gl.bindVertexArray(song.vao);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      song.buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, song.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 0);
      gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 24, 16);
      gl.vertexAttribDivisor(2, 1);
    });
    gl.bindVertexArray(null);
  }

  /* GPU */

  _initGL() {
    const { gl, atlas, scene } = this;

    this.backdrop = createProgram(gl, BACKDROP_VERT, BACKDROP_FRAG);
    this.glyphs = createProgram(gl, GLYPH_VERT, GLYPH_FRAG);
    this.emptyVao = gl.createVertexArray();

    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

    this.photoTexture = createTexture(gl, scene.photo);
    this.maskTexture = createTexture(gl, scene.mask);

    this.atlasTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, atlas.width, atlas.height, 0, gl.RED, gl.UNSIGNED_BYTE, atlas.pixels);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);

    this.songs.forEach((song) => { song.vao = null; });

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  _resize(force = false) {
    const { canvas, gl, scene } = this;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;

    const sameWidth = this.metrics && width === this.metrics.width;
    const sameHeight = this.metrics && height === this.metrics.height;
    if (!force && sameWidth && sameHeight) return;

    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * this.dpr);
    canvas.height = Math.round(height * this.dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);

    const narrow = width < 760;
    const density = this.options.density || 1;
    const font = (narrow ? clamp(width / 58, 6, 7.5) : clamp(width / 195, 6.8, 9)) / density;
    this.metrics = {
      width,
      height,
      font,
      rowHeight: font * (this.options.uppercase ? 0.8 : 1),
      tracking: font * 0.015,
    };

    this._layoutPhoto();
    this._buildGeometry();
  }

  /* Places the photo so the head always lands in a good spot, whatever
     the screen or the photo's proportions. */
  _layoutPhoto() {
    const { width, height } = this.metrics;
    const { photo, analysis } = this.scene;
    const aspect = photo.width / photo.height;
    const { focus } = analysis;
    const wide = width / height > 1.05;

    let h;
    let w;
    let centerX;
    let headY;
    if (wide) {
      h = height * 1.2;
      w = h * aspect;
      const maxWidth = width * 0.62;
      if (w > maxWidth) {
        w = maxWidth;
        h = w / aspect;
      }
      centerX = width * 0.68;
      headY = height * 0.4;
    } else {
      h = height * 1.02;
      w = h * aspect;
      if (w < width) {
        w = width;
        h = w / aspect;
      }
      centerX = width * 0.5;
      headY = height * 0.36;
    }

    const x = centerX - w * focus.x;
    let y = headY - h * focus.y;
    if (h >= height) y = clamp(y, height - h, 0);

    this.stacked = !wide;
    this._rect = { x, y, w, h };
    this.head = { x: x + w * focus.x, y: y + h * focus.y };
  }

  /* Loop */

  _loop = (now) => {
    this.raf = requestAnimationFrame(this._loop);
    const dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    this.time += dt;

    this.onFrame?.(dt);

    const easeTo = (value, target, rate) => value + (target - value) * (1 - Math.exp(-dt * rate));

    if (this.assemble < 1) this.assemble = Math.min(1, this.assemble + dt / ASSEMBLE_SECONDS);
    this.open = easeTo(this.open, 1, 1.4);
    this.dim = easeTo(this.dim, this.dimTarget, 3.5);
    this.hot = easeTo(this.hot, this.activeLine >= 0 ? 1 : 0, 5);

    const { pointer } = this;
    pointer.x = easeTo(pointer.x, pointer.tx, 11);
    pointer.y = easeTo(pointer.y, pointer.ty, 11);
    pointer.strength = easeTo(pointer.strength, pointer.target, 7);

    const step = dt / FADE_SECONDS;
    this.songs.forEach((song) => {
      if (song.presence < song.target) song.presence = Math.min(song.target, song.presence + step);
      if (song.presence > song.target) song.presence = Math.max(song.target, song.presence - step);
    });

    if (!this.reduced) {
      const speed = FLOW_SPEED * (this.options.flow ?? 1) * (1 - 0.82 * pointer.strength);
      this.flow += speed * dt;
    }

    this._draw();
  };

  _draw() {
    const { gl, metrics, songs, atlas } = this;
    const { backdrop, glyphs } = this;
    const lensRadius = clamp(Math.min(metrics.width, metrics.height) * 0.27, 120, 250);

    /* On vertical screens the final message sits below the face: the photo
       rises as it appears, so the text never covers it. */
    const lift = this.stacked ? this.reveal * metrics.height * 0.1 : 0;
    const rect = { ...this._rect, y: this._rect.y - lift };
    const head = { x: this.head.x, y: this.head.y - lift };

    /* The background blends the palettes of the songs that are present. */
    const total = songs.reduce((sum, song) => sum + song.presence, 0) || 1;
    const blend = (slot) => [0, 1, 2].map((channel) =>
      songs.reduce((sum, song) => sum + song.colors[slot][channel] * song.presence, 0) / total);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.photoTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTexture);

    gl.disable(gl.BLEND);
    gl.useProgram(backdrop.program);
    let u = backdrop.uniforms;
    gl.uniform2f(u.uRes, metrics.width, metrics.height);
    gl.uniform1f(u.uDpr, this.dpr);
    gl.uniform1f(u.uTime, this.time);
    gl.uniform1f(u.uReveal, this.reveal);
    gl.uniform1f(u.uDim, this.dim);
    gl.uniform1f(u.uOpen, this.open);
    gl.uniform1f(u.uAssemble, this.assemble);
    gl.uniform4f(u.uRect, rect.x, rect.y, rect.w, rect.h);
    gl.uniform2f(u.uHead, head.x, head.y);
    gl.uniform3fv(u.uBase, blend(0));
    gl.uniform3fv(u.uGlow, blend(1));
    gl.uniform3f(u.uPointer, this.pointer.x, this.pointer.y, this.pointer.strength);
    gl.uniform1f(u.uLensR, lensRadius);
    gl.uniform1i(u.uPhoto, 0);
    gl.uniform1i(u.uMask, 1);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    /* By the ending no letters remain: nothing else to draw. */
    if (this.scatter >= 1) return;

    gl.enable(gl.BLEND);
    gl.useProgram(glyphs.program);
    u = glyphs.uniforms;
    gl.uniform2f(u.uRes, metrics.width, metrics.height);
    gl.uniform2f(u.uGrid, atlas.cols, atlas.rows);
    gl.uniform2f(u.uHead, head.x, head.y);
    gl.uniform2f(u.uOriginEm, ORIGIN_EM[0], ORIGIN_EM[1]);
    gl.uniform1f(u.uCellEm, CELL_EM);
    gl.uniform1f(u.uFont, metrics.font);
    gl.uniform1f(u.uFlow, this.flow);
    gl.uniform1f(u.uRowLen, metrics.width + MARGIN * 2);
    gl.uniform1f(u.uMargin, MARGIN);
    gl.uniform1f(u.uTime, this.time);
    gl.uniform3f(u.uPointer, this.pointer.x, this.pointer.y, this.pointer.strength);
    gl.uniform1f(u.uLensR, lensRadius);
    gl.uniform1f(u.uLensPower, LENS_POWER);
    gl.uniform1f(u.uAssemble, this.assemble);
    gl.uniform1f(u.uScatter, this.scatter);
    gl.uniform1f(u.uHot, this.hot);
    gl.uniform1f(u.uDim, this.dim);
    gl.uniform1f(u.uEdge, EDGE_VALUE);
    gl.uniform2f(u.uLevels, this.scene.analysis.levels[0], this.scene.analysis.levels[1]);
    gl.uniform4f(u.uRect, rect.x, rect.y, rect.w, rect.h);
    gl.uniform1i(u.uPhoto, 0);
    gl.uniform1i(u.uMask, 1);
    gl.uniform1i(u.uAtlas, 2);

    /* Outgoing songs first, so the new one ends up on top. */
    const order = songs.map((song, index) => ({ song, index }))
      .filter(({ song }) => song.presence > 0.001)
      .sort((a, b) => a.song.target - b.song.target);

    for (const { song, index } of order) {
      gl.uniform1f(u.uPresence, song.presence);
      gl.uniform1f(u.uLeaving, song.leaving ? 1 : 0);
      gl.uniform1f(u.uActiveLine, index === this.current ? this.activeLine : -9);
      gl.uniform3fv(u.uShadow, song.colors[0]);
      gl.uniform3fv(u.uMid, song.colors[1]);
      gl.uniform3fv(u.uLight, song.colors[2]);
      gl.bindVertexArray(song.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, song.count);
    }
    gl.bindVertexArray(null);
  }
}
