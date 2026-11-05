/* Builds the page from config.js and connects it to the portrait. */

import { Portrait } from './portrait.js';
import { detectPerson, ovalMask } from './automask.js';

const config = window.PORTRAIT;
const text = config?.text ?? {};
const options = { uppercase: true, density: 1, flow: 1, ...config?.options };

const GLYPH_FONT = { family: '"Jost", "Futura", "Century Gothic", sans-serif', weight: 500 };
const DEFAULT_PALETTES = [
  ['#2a1407', '#d4923f', '#fff0d6'],
  ['#2a0610', '#e23a58', '#ffe0d6'],
  ['#120a38', '#8b6cff', '#ffd6f0'],
];
const MAX_PHOTO_SIDE = 1600;

const $ = (selector) => document.querySelector(selector);

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function fail(title, detail) {
  const notice = $('#notice');
  notice.replaceChildren(el('strong', '', title), el('span', '', detail));
  notice.hidden = false;
  $('#veil').classList.add('is-gone');
}

/* ─────────────────────────────── Data ─────────────────────────────── */

/* Cleans up what lyrics sites usually add: [Chorus] tags, extra blank
   lines and so on. Blank lines separate stanzas. */
function parseLyrics(raw) {
  const stanzas = [[]];
  for (const rawLine of raw.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (stanzas.at(-1).length) stanzas.push([]);
    } else if (!/^\[.*\]$/.test(line)) {
      stanzas.at(-1).push(line);
    }
  }
  return stanzas.filter((stanza) => stanza.length);
}

async function loadLyrics(song, index) {
  let response;
  try {
    response = await fetch(song.lyrics);
  } catch {
    throw new Error(`Could not read "${song.lyrics}".`);
  }
  if (!response.ok) throw new Error(`Could not find "${song.lyrics}". Check that name in config.js: capitalization matters.`);

  const stanzas = parseLyrics(await response.text());
  if (!stanzas.length) throw new Error(`"${song.lyrics}" is empty.`);

  return {
    ...song,
    stanzas,
    lines: stanzas.flat(),
    palette: song.palette ?? DEFAULT_PALETTES[index % DEFAULT_PALETTES.length],
  };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not find the image "${src}". Check that name in config.js: capitalization matters.`));
    image.src = src;
  });
}

/* Going through a canvas respects the photo's orientation and shrinks huge ones. */
function toCanvas(image, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(image, 0, 0, width, height);
  return canvas;
}

function photoCanvas(image) {
  const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  return toCanvas(image, Math.round(image.naturalWidth * scale), Math.round(image.naturalHeight * scale));
}

/* How much of the image the mask covers. */
function coverage(mask) {
  const { data } = toCanvas(mask, 32, 32)
    .getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, 32, 32);
  let covered = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 127) covered++;
  }
  return covered / (32 * 32);
}

async function resolveMask(photo) {
  if (config.mask) return toCanvas(await loadImage(config.mask), photo.width, photo.height);
  try {
    const detected = await detectPerson(photo);
    if (coverage(detected) > 0.03) return detected;
    console.info('No person in the photo, using a soft oval.');
  } catch (error) {
    console.warn('Could not detect a person, using a soft oval.', error);
  }
  return ovalMask(photo.width, photo.height);
}

/* Looks at tiny versions of the photo and mask to find the head and how
   bright or dark the person is. That way any photo gets good framing and
   contrast without touching anything. */
function analyse(photo, mask) {
  const width = 96;
  const height = Math.round(width * (photo.height / photo.width));
  const read = (source) => toCanvas(source, width, height)
    .getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, width, height).data;
  const photoData = read(photo);
  const maskData = read(mask);

  let top = height;
  let bottom = 0;
  const histogram = new Float64Array(256);
  let covered = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const weight = maskData[i] / 255;
      if (weight > 0.5) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        covered++;
      }
      const luma = 0.299 * photoData[i] + 0.587 * photoData[i + 1] + 0.114 * photoData[i + 2];
      histogram[Math.round(luma)] += weight;
    }
  }

  /* The head is the top third of the silhouette. */
  const headBottom = top + (bottom - top) * 0.34;
  let sumX = 0;
  let sumWeight = 0;
  for (let y = top; y < headBottom; y++) {
    for (let x = 0; x < width; x++) {
      const weight = maskData[(y * width + x) * 4] / 255;
      sumX += x * weight;
      sumWeight += weight;
    }
  }

  const total = histogram.reduce((a, b) => a + b, 0);
  const percentile = (fraction) => {
    let sum = 0;
    for (let i = 0; i < 256; i++) {
      sum += histogram[i];
      if (sum >= total * fraction) return i / 255;
    }
    return 1;
  };

  const found = covered > width * height * 0.03;
  return {
    focus: found
      ? { x: sumX / sumWeight / width, y: (top + (bottom - top) * 0.2) / height }
      : { x: 0.5, y: 0.4 },
    levels: [percentile(0.02), Math.max(percentile(0.985), percentile(0.02) + 0.2)],
  };
}

/* ─────────────────────────────── Page ─────────────────────────────── */

const pad = (n) => String(n).padStart(2, '0');

function listenUrl(song) {
  if (song.listen) return song.listen;
  return `https://open.spotify.com/search/${encodeURIComponent(`${song.title} ${song.artist}`)}`;
}

function buildHero() {
  const hero = el('section', 'hero');
  hero.id = 'home';

  const inner = el('div', 'hero__inner');
  const name = el('h1', 'hero__name');
  name.setAttribute('aria-label', config.name);
  name.style.setProperty('--chars', Array.from(config.name).length);
  Array.from(config.name).forEach((char, i) => {
    const wrap = el('span', 'hero__char');
    wrap.setAttribute('aria-hidden', 'true');
    const glyph = el('span', '', char);
    glyph.style.setProperty('--i', i);
    wrap.append(glyph);
    name.append(wrap);
  });

  inner.append(el('p', 'eyebrow', text.eyebrow), name, el('p', 'hero__lede', text.lede));

  const cue = el('a', 'scroll-cue');
  cue.href = '#song-1';
  cue.append(el('span', '', text.scroll), el('i'));

  hero.append(inner, cue);
  return hero;
}

function buildSong(song, index, total) {
  const section = el('section', 'song');
  section.id = `song-${index + 1}`;
  section.dataset.song = index;

  const head = el('header', 'song__head');
  const label = el('p', 'eyebrow');
  label.append(`${text.songLabel} ${pad(index + 1)} `, el('span', 'eyebrow__dim', `/ ${pad(total)}`));

  head.append(label, el('h2', 'song__title', song.title), el('p', 'song__artist', song.artist));

  if (song.listen !== false) {
    const listen = el('a', 'listen');
    listen.href = listenUrl(song);
    listen.target = '_blank';
    listen.rel = 'noopener';
    listen.append(el('span', '', text.listen), el('i', '', '↗'));
    head.append(listen);
  }

  const lyrics = el('div', 'lyrics');
  let line = 0;
  for (const stanza of song.stanzas) {
    const block = el('p', 'stanza');
    for (const verse of stanza) {
      const span = el('span', 'line', verse);
      span.dataset.line = line++;
      block.append(span);
    }
    lyrics.append(block);
  }

  section.append(head, lyrics);
  return section;
}

function buildEnding() {
  const section = el('section', 'ending');
  section.id = 'ending';

  const sticky = el('div', 'ending__sticky');
  const card = el('div', 'ending__card');
  const restart = el('a', 'restart', text.restart);
  restart.href = '#home';
  card.append(
    el('p', 'eyebrow', text.endingEyebrow),
    el('h2', 'ending__title', text.endingTitle),
    el('p', 'ending__message', text.endingMessage),
    el('p', 'ending__signature', text.signature),
    restart,
  );
  sticky.append(card);
  section.append(sticky);
  return section;
}

function buildChapters(songs) {
  const nav = $('#chapters');
  songs.forEach((song, i) => {
    const link = el('a', '', pad(i + 1));
    link.href = `#song-${i + 1}`;
    link.title = song.title;
    link.dataset.chapter = i;
    nav.append(link);
  });
  const end = el('a', 'chapters__end', '♥');
  end.href = '#ending';
  end.title = text.endingEyebrow;
  end.dataset.chapter = 'ending';
  nav.append(end);
}

function setAccent(palette) {
  document.documentElement.style.setProperty('--accent', palette[1]);
  document.documentElement.style.setProperty('--accent-light', palette[2]);
}

/* ────────────────────────── Scroll and cursor ────────────────────────── */

function connectStory(portrait, songs) {
  const narrow = () => matchMedia('(max-width: 759px), (max-aspect-ratio: 21/20)').matches;
  const sections = [...document.querySelectorAll('.song')];
  const ending = $('#ending');
  const chapterLinks = [...document.querySelectorAll('#chapters a')];

  let inSong = false;
  let activeLine = -1;
  const reading = new Set();

  const markChapter = (id) => chapterLinks.forEach((link) => {
    link.classList.toggle('is-active', link.dataset.chapter === String(id));
  });

  const atCenter = { rootMargin: '-50% 0px -50% 0px' };

  /* Which song is at the center of the screen. */
  const songObserver = new IntersectionObserver((entries) => {
    entries.forEach(({ target, isIntersecting }) => {
      if (!isIntersecting) return;
      if (target.dataset.song !== undefined) {
        const index = Number(target.dataset.song);
        inSong = true;
        portrait?.setSong(index);
        setAccent(songs[index].palette);
        markChapter(index);
      } else {
        inSong = false;
        markChapter(target.id === 'ending' ? 'ending' : '');
      }
    });
  }, atCenter);
  [$('#home'), ...sections, ending].forEach((section) => songObserver.observe(section));

  /* Which verse is being read: it lights up here and inside the portrait. */
  const lineObserver = new IntersectionObserver((entries) => {
    entries.forEach(({ target, isIntersecting }) => {
      if (!isIntersecting) return;
      document.querySelector('.line.is-active')?.classList.remove('is-active');
      target.classList.add('is-active');
      activeLine = Number(target.dataset.line);
    });
  }, { rootMargin: '-46% 0px -46% 0px' });
  document.querySelectorAll('.line').forEach((line) => lineObserver.observe(line));

  const lyricsObserver = new IntersectionObserver((entries) => {
    entries.forEach(({ isIntersecting, target }) => {
      if (isIntersecting) {
        reading.add(target);
      } else {
        reading.delete(target);
        target.querySelector('.line.is-active')?.classList.remove('is-active');
      }
    });
    if (!reading.size) activeLine = -1;
  }, atCenter);
  document.querySelectorAll('.lyrics').forEach((lyrics) => lyricsObserver.observe(lyrics));

  /* The final scene is driven by scrolling, frame by frame. */
  const update = () => {
    const view = window.innerHeight;
    const top = ending.getBoundingClientRect().top;
    const progress = Math.min(1, Math.max(0, (view * 0.85 - top) / (view * 1.15)));
    const eased = progress * progress * (3 - 2 * progress);

    const isReading = reading.size > 0;
    portrait?.setReveal(eased);
    portrait?.setActiveLine(activeLine);
    ending.classList.toggle('is-open', progress > 0.62);
    document.documentElement.classList.toggle('is-reading', isReading);

    let dim = 1;
    if (isReading) dim = narrow() ? 0.2 : 0.72;
    else if (inSong) dim = narrow() ? 0.62 : 1;
    portrait?.setDim(dim);
  };

  if (portrait) portrait.onFrame = update;
  else {
    addEventListener('scroll', update, { passive: true });
    update();
  }
}

function connectPointer(portrait) {
  const hint = $('#hint');
  const canHover = matchMedia('(hover: hover) and (pointer: fine)').matches;
  hint.textContent = canHover ? text.hintMouse : text.hintTouch;

  const insidePortrait = (x, y) => {
    const { rect } = portrait;
    return x > rect.x + rect.w * 0.06 && x < rect.x + rect.w * 0.94 && y > rect.y && y < rect.y + rect.h;
  };

  const dismissHint = () => hint.classList.add('is-gone');

  if (canHover) {
    addEventListener('pointermove', (event) => {
      const free = !event.target.closest?.('a, button');
      const inside = free && portrait.reveal < 0.4 && insidePortrait(event.clientX, event.clientY);
      portrait.setPointer(event.clientX, event.clientY, inside);
      if (inside) dismissHint();
    }, { passive: true });
    document.documentElement.addEventListener('pointerleave', () => {
      portrait.setPointer(portrait.pointer.tx, portrait.pointer.ty, false);
    });
  } else {
    let timer;
    addEventListener('click', (event) => {
      if (event.target.closest('a, button') || portrait.reveal > 0.4 || portrait.dim < 0.5) return;
      portrait.setPointer(event.clientX, event.clientY, true);
      dismissHint();
      clearTimeout(timer);
      timer = setTimeout(() => portrait.setPointer(event.clientX, event.clientY, false), 2800);
    });
  }

  setTimeout(() => { hint.hidden = false; }, 5200);
  addEventListener('scroll', () => {
    if (scrollY > innerHeight * 0.5) dismissHint();
  }, { passive: true });
}

/* ─────────────────────────────── Start ─────────────────────────────── */

async function main() {
  if (!config) {
    fail('config.js is missing', 'The page could not find its configuration file.');
    return;
  }

  history.scrollRestoration = 'manual';
  scrollTo(0, 0);

  $('#veil-label').textContent = text.loading ?? '';
  $('#brand').textContent = config.name;
  document.title = `${config.name} · ${text.eyebrow}`;

  if (location.protocol === 'file:') {
    fail(
      'Open this page from a server',
      'Browsers block reading local files when you double-click. Publish it on GitHub Pages or, in this folder, run: npx serve',
    );
    return;
  }

  let songs;
  let image;
  try {
    [songs, image] = await Promise.all([
      Promise.all(config.songs.map(loadLyrics)),
      loadImage(config.photo),
      document.fonts.load(`${GLYPH_FONT.weight} 40px Jost`),
      document.fonts.load('italic 400 40px "Bodoni Moda"'),
    ]);
  } catch (error) {
    fail('Something is missing in config.js', error.message);
    return;
  }

  const story = $('#story');
  story.append(
    buildHero(),
    ...songs.map((song, i) => buildSong(song, i, songs.length)),
    buildEnding(),
  );
  buildChapters(songs);
  setAccent(songs[0].palette);

  let portrait = null;
  try {
    const photo = photoCanvas(image);
    const mask = await resolveMask(photo);
    portrait = new Portrait($('#stage'), {
      photo,
      mask,
      analysis: analyse(photo, mask),
      songs,
      font: GLYPH_FONT,
      options,
    });
    portrait.start();
    connectPointer(portrait);
  } catch (error) {
    /* Without WebGL2 the page still looks good: photo background plus the lyrics. */
    console.warn('Portrait without WebGL:', error);
    document.documentElement.classList.add('no-webgl');
    document.documentElement.style.setProperty('--photo', `url("${new URL(config.photo, location.href)}")`);
  }

  connectStory(portrait, songs);

  setTimeout(() => {
    document.documentElement.classList.add('is-ready');
    $('#veil').classList.add('is-gone');
  }, 60);
}

main();
