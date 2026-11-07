#!/usr/bin/env node
// Scans music/ and writes songs.json. No dependencies: run with `node scripts/generate-songs.js`.
//
// Layout:  music/<Album name>/cover.jpg
//          music/<Album name>/01 - Song title.mp3
// Album title = folder name. Song title and track number come from the file's tags
// when it has them, otherwise from the file name. Loose files directly in music/
// are collected into an album called "Singles".
//
// Artist, strongest first:  artist.txt in the album folder (whole album)
//                           the file's tags
//                           the file name, "Artist - Title.mp3"
// Covers:  Song title.jpg next to Song title.mp3 is that song's cover.
//          cover.jpg, or any other image in the folder, is the album's cover.
//          With no album image, the first song cover is used.

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MUSIC_DIR = path.join(ROOT, 'music');
const OUTPUT = path.join(ROOT, 'songs.json');

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac']);
const UNSUPPORTED_EXT = new Set(['.ogg', '.oga', '.opus', '.wma', '.aiff', '.aif', '.alac', '.ape']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const COVER_NAMES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp'];

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// ---------------------------------------------------------------- MP3 / ID3

function syncsafe(b, o) {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}

function decodeId3Text(buf) {
  if (!buf.length) return '';
  const enc = buf[0];
  const body = buf.subarray(1);
  let text;
  if (enc === 0) text = body.toString('latin1');
  else if (enc === 3) text = body.toString('utf8');
  else if (enc === 1) {
    const bigEndian = body[0] === 0xfe && body[1] === 0xff;
    const hasBom = bigEndian || (body[0] === 0xff && body[1] === 0xfe);
    text = decodeUtf16(hasBom ? body.subarray(2) : body, bigEndian);
  } else if (enc === 2) text = decodeUtf16(body, true);
  else return '';
  // Multi-value frames are NUL-separated; the first value is the one we want.
  return text.split('\0')[0].trim();
}

function decodeUtf16(buf, bigEndian) {
  const copy = Buffer.from(buf.subarray(0, buf.length - (buf.length % 2)));
  if (bigEndian) copy.swap16();
  return copy.toString('utf16le');
}

function parseId3v2(b) {
  const tags = {};
  if (b.length < 10 || b.toString('latin1', 0, 3) !== 'ID3') return { tags, end: 0 };
  const major = b[3];
  const flags = b[5];
  const size = syncsafe(b, 6);
  const end = 10 + size + (flags & 0x10 ? 10 : 0);

  let p = 10;
  if (flags & 0x40 && major >= 3) {
    p += major === 4 ? syncsafe(b, p) : b.readUInt32BE(p) + 4;
  }
  const idLen = major === 2 ? 3 : 4;
  const headerLen = major === 2 ? 6 : 10;
  const limit = Math.min(10 + size, b.length);

  while (p + headerLen <= limit) {
    const id = b.toString('latin1', p, p + idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let frameSize;
    if (major === 2) frameSize = (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5];
    else if (major === 4) frameSize = syncsafe(b, p + 4);
    else frameSize = b.readUInt32BE(p + 4);
    if (frameSize <= 0 || p + headerLen + frameSize > limit) break;
    const data = b.subarray(p + headerLen, p + headerLen + frameSize);
    if (id === 'TIT2' || id === 'TT2') tags.title = decodeId3Text(data);
    else if (id === 'TPE1' || id === 'TP1') tags.artist = decodeId3Text(data);
    else if (id === 'TRCK' || id === 'TRK') tags.track = parseInt(decodeId3Text(data), 10);
    p += headerLen + frameSize;
  }
  return { tags, end };
}

const MP3_BITRATES = {
  // [MPEG1 by layer 1..3], [MPEG2/2.5 by layer 1..3], kbps
  v1: [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  ],
  v2: [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
};
const MP3_SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function mp3Duration(b, start) {
  for (let p = start; p + 4 < b.length; p++) {
    if (b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) continue;
    const version = (b[p + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layerBits = (b[p + 1] >> 1) & 3; // 3 = layer I, 1 = layer III
    const bitrateIdx = b[p + 2] >> 4;
    const rateIdx = (b[p + 2] >> 2) & 3;
    if (version === 1 || layerBits === 0 || bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) continue;

    const layer = 4 - layerBits;
    const sampleRate = MP3_SAMPLE_RATES[version][rateIdx];
    const kbps = MP3_BITRATES[version === 3 ? 'v1' : 'v2'][layer - 1][bitrateIdx];
    const mono = b[p + 3] >> 6 === 3;
    const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : version === 3 ? 1152 : 576;

    // VBR files carry the frame count in a Xing/Info or VBRI header in frame one.
    const sideInfo = version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
    const xing = p + 4 + sideInfo;
    if (xing + 12 <= b.length) {
      const tag = b.toString('latin1', xing, xing + 4);
      if ((tag === 'Xing' || tag === 'Info') && b.readUInt32BE(xing + 4) & 1) {
        return (b.readUInt32BE(xing + 8) * samplesPerFrame) / sampleRate;
      }
    }
    const vbri = p + 36;
    if (vbri + 18 <= b.length && b.toString('latin1', vbri, vbri + 4) === 'VBRI') {
      return (b.readUInt32BE(vbri + 14) * samplesPerFrame) / sampleRate;
    }

    let audioBytes = b.length - p;
    if (b.length >= 128 && b.toString('latin1', b.length - 128, b.length - 125) === 'TAG') audioBytes -= 128;
    return (audioBytes * 8) / (kbps * 1000);
  }
  return null;
}

function readMp3(b) {
  const { tags, end } = parseId3v2(b);
  return { ...tags, duration: mp3Duration(b, end) };
}

// ---------------------------------------------------------------- M4A

function walkAtoms(b, start, end, visit) {
  let p = start;
  while (p + 8 <= end) {
    let size = b.readUInt32BE(p);
    const type = b.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) return;
      size = Number(b.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) return;
    visit(type, p + header, p + size);
    p += size;
  }
}

function readM4a(b) {
  const out = {};
  walkAtoms(b, 0, b.length, (type, s, e) => {
    if (type !== 'moov') return;
    walkAtoms(b, s, e, (t2, s2, e2) => {
      if (t2 === 'mvhd') {
        const v1 = b[s2] === 1;
        const timescale = b.readUInt32BE(s2 + (v1 ? 20 : 12));
        const units = v1 ? Number(b.readBigUInt64BE(s2 + 24)) : b.readUInt32BE(s2 + 16);
        if (timescale) out.duration = units / timescale;
      } else if (t2 === 'udta') {
        walkAtoms(b, s2, e2, (t3, s3, e3) => {
          if (t3 !== 'meta') return;
          walkAtoms(b, s3 + 4, e3, (t4, s4, e4) => {
            if (t4 !== 'ilst') return;
            walkAtoms(b, s4, e4, (key, s5, e5) => {
              walkAtoms(b, s5, e5, (t6, s6, e6) => {
                if (t6 !== 'data') return;
                const value = b.subarray(s6 + 8, e6);
                if (key === '\xa9nam') out.title = value.toString('utf8').trim();
                else if (key === '\xa9ART') out.artist = value.toString('utf8').trim();
                else if (key === 'trkn' && value.length >= 4) out.track = value.readUInt16BE(2);
              });
            });
          });
        });
      }
    });
  });
  return out;
}

// ---------------------------------------------------------------- FLAC / WAV

function readFlac(b) {
  const out = {};
  if (b.toString('latin1', 0, 4) !== 'fLaC') return out;
  let p = 4;
  while (p + 4 <= b.length) {
    const last = b[p] & 0x80;
    const type = b[p] & 0x7f;
    const len = b.readUIntBE(p + 1, 3);
    const s = p + 4;
    if (type === 0 && len >= 18) {
      const sampleRate = (b[s + 10] << 12) | (b[s + 11] << 4) | (b[s + 12] >> 4);
      const samples = (b[s + 13] & 0x0f) * 2 ** 32 + b.readUInt32BE(s + 14);
      if (sampleRate) out.duration = samples / sampleRate;
    } else if (type === 4) {
      let q = s + 4 + b.readUInt32LE(s);
      const count = b.readUInt32LE(q);
      q += 4;
      for (let i = 0; i < count && q + 4 <= s + len; i++) {
        const n = b.readUInt32LE(q);
        const entry = b.toString('utf8', q + 4, q + 4 + n);
        q += 4 + n;
        const eq = entry.indexOf('=');
        const key = entry.slice(0, eq).toUpperCase();
        const value = entry.slice(eq + 1).trim();
        if (key === 'TITLE') out.title = value;
        else if (key === 'ARTIST') out.artist = value;
        else if (key === 'TRACKNUMBER') out.track = parseInt(value, 10);
      }
    }
    if (last) break;
    p = s + len;
  }
  return out;
}

function readWav(b) {
  const out = {};
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return out;
  let p = 12;
  let byteRate = 0;
  while (p + 8 <= b.length) {
    const id = b.toString('latin1', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') byteRate = b.readUInt32LE(p + 16);
    else if (id === 'data' && byteRate) out.duration = Math.min(size, b.length - p - 8) / byteRate;
    p += 8 + size + (size % 2);
  }
  return out;
}

const READERS = { '.mp3': readMp3, '.m4a': readM4a, '.flac': readFlac, '.wav': readWav };

function readMetadata(file) {
  const reader = READERS[path.extname(file).toLowerCase()];
  if (!reader) return {};
  try {
    return reader(fs.readFileSync(file));
  } catch (err) {
    console.warn(`  ! could not read tags from ${path.relative(ROOT, file)}: ${err.message}`);
    return {};
  }
}

// ---------------------------------------------------------------- Scan

// "01 - Katy Perry - Firework (Official Video) - 320.mp3" -> Katy Perry / Firework
function parseFilename(name) {
  const cleaned = path
    .basename(name, path.extname(name))
    .normalize('NFKC') // decorative Unicode letters become plain ones
    .replace(/^\s*\d{1,3}\s*[-._)]*\s+/, '') // "01 - Song", "1. Song", "03 Song"
    .replace(/_/g, ' ')
    .replace(/\s*[([](official\s*(music\s*|lyrics?\s*|audio\s*)?(video|audio)?|lyrics?(\s*video)?|audio|hd|hq|4k|visuali[sz]er)[)\]]/gi, '')
    .replace(/\s+-\s+\d{2,3}(\s*kbps)?\s*$/i, '') // "- 320" left by download tools
    .replace(/\s+/g, ' ')
    .trim();
  const split = cleaned.indexOf(' - ');
  if (split > 0) return { artist: cleaned.slice(0, split).trim(), title: cleaned.slice(split + 3).trim() || name };
  return { artist: null, title: cleaned || name };
}

function trackNumberFromFilename(name) {
  const m = /^\s*(\d{1,3})(?=\s|[-._)])/.exec(name);
  return m ? parseInt(m[1], 10) : null;
}

function toWebPath(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function scanTrack(file, albumArtist, images) {
  const name = path.basename(file);
  const meta = readMetadata(file);
  const parsed = parseFilename(name);
  const stem = path.basename(file, path.extname(file)).toLowerCase();
  const track = {
    path: toWebPath(file),
    title: meta.title || parsed.title,
    artist: albumArtist || meta.artist || parsed.artist,
    track: Number.isFinite(meta.track) && meta.track > 0 ? meta.track : trackNumberFromFilename(name),
    duration: Number.isFinite(meta.duration) ? Math.round(meta.duration) : null,
    cover: images.get(stem) || null,
  };
  return track;
}

function sortTracks(tracks) {
  return tracks.sort((a, b) => {
    if (a.track != null && b.track != null && a.track !== b.track) return a.track - b.track;
    if (a.track != null && b.track == null) return -1;
    if (a.track == null && b.track != null) return 1;
    return collator.compare(a.path, b.path);
  });
}

function albumArtistFrom(values) {
  const known = values.filter(Boolean);
  const counts = new Map();
  for (const v of known) counts.set(v, (counts.get(v) || 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  return ranked[0][1] / known.length >= 0.6 ? ranked[0][0] : 'Various Artists';
}

function listAudio(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const ext = path.extname(entry.name).toLowerCase();
    if (entry.isDirectory()) {
      if (dir !== MUSIC_DIR) console.warn(`  ! ignored nested folder ${toWebPath(full)} (albums must sit directly in music/)`);
    } else if (AUDIO_EXT.has(ext)) {
      files.push(full);
    } else if (UNSUPPORTED_EXT.has(ext)) {
      console.warn(`  ! skipped ${toWebPath(full)} (iPhone cannot reliably play ${ext}; use mp3 or m4a)`);
    }
  }
  return files;
}

// Images in a folder, keyed by lowercase name without the extension.
function listImages(dir) {
  const images = new Map();
  const files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  for (const name of files.sort(collator.compare)) {
    if (!IMAGE_EXT.has(path.extname(name).toLowerCase())) continue;
    const stem = path.basename(name, path.extname(name)).toLowerCase();
    if (!images.has(stem)) images.set(stem, toWebPath(path.join(dir, name)));
  }
  return images;
}

function findAlbumCover(dir, images, audioFiles, tracks) {
  const entries = fs.readdirSync(dir);
  for (const wanted of COVER_NAMES) {
    const hit = entries.find((e) => e.toLowerCase() === wanted);
    if (hit) return toWebPath(path.join(dir, hit));
  }
  const songStems = new Set(audioFiles.map((f) => path.basename(f, path.extname(f)).toLowerCase()));
  for (const [stem, image] of images) if (!songStems.has(stem)) return image;
  return tracks.find((t) => t.cover)?.cover || null;
}

function readAlbumArtist(dir) {
  const hit = fs.readdirSync(dir).find((e) => e.toLowerCase() === 'artist.txt');
  if (!hit) return null;
  const firstLine = fs.readFileSync(path.join(dir, hit), 'utf8').replace(/^﻿/, '').split(/\r?\n/)[0];
  return firstLine.trim() || null;
}

function buildAlbum(id, title, dir, files) {
  const albumArtist = readAlbumArtist(dir);
  const images = listImages(dir);
  const tracks = sortTracks(files.map((f) => scanTrack(f, albumArtist, images)));
  return {
    id,
    title,
    artist: albumArtist || albumArtistFrom(tracks.map((t) => t.artist)),
    cover: findAlbumCover(dir, images, files, tracks),
    tracks,
  };
}

function scan() {
  const albums = [];
  if (!fs.existsSync(MUSIC_DIR)) return albums;

  for (const entry of fs.readdirSync(MUSIC_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(MUSIC_DIR, entry.name);
    const files = listAudio(dir);
    if (!files.length) {
      console.warn(`  ! skipped music/${entry.name} (no playable audio files)`);
      continue;
    }
    const album = buildAlbum(entry.name, entry.name, dir, files);
    if (!album.cover) console.warn(`  ! music/${entry.name} has no cover image`);
    albums.push(album);
  }
  albums.sort((a, b) => collator.compare(a.title, b.title));

  const loose = listAudio(MUSIC_DIR);
  if (loose.length) albums.push(buildAlbum('__singles__', 'Singles', MUSIC_DIR, loose));
  return albums;
}

const albums = scan();
fs.writeFileSync(OUTPUT, JSON.stringify({ albums }, null, 2) + '\n');
const trackCount = albums.reduce((n, a) => n + a.tracks.length, 0);
console.log(`songs.json: ${albums.length} album(s), ${trackCount} track(s)`);
for (const a of albums) console.log(`  ${a.title} (${a.tracks.length})`);
