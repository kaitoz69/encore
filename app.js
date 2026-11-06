'use strict';

const APP_NAME = document.title;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const audio = $('#audio');
const viewEl = $('#view');

// ------------------------------------------------------------------ Helpers

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch { /* private mode or full storage: nothing to do */ }
  },
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const mediaUrl = (p) => p.split('/').map(encodeURIComponent).join('/');
const absUrl = (p) => new URL(p, location.href).href;
const icon = (name, cls = '') => `<svg class="icon ${cls}"><use href="#i-${name}"/></svg>`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const normalize = (s) => (s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function fmtTotal(tracks) {
  const total = tracks.reduce((n, t) => n + (t.duration || 0), 0);
  if (!total) return '';
  const min = Math.round(total / 60);
  return min >= 60 ? `${Math.floor(min / 60)} hr ${min % 60} min` : `${min} min`;
}

function hueOf(str) {
  let h = 0;
  for (const c of str) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}

function setIcon(host, name) {
  host.querySelector('use').setAttribute('href', `#i-${name}`);
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2800);
}

function coverHtml(cover, title, eager = false) {
  const initial = esc(Array.from((title || '?').trim())[0] || '?');
  const img = cover
    ? `<img src="${esc(mediaUrl(cover))}" alt="" draggable="false" decoding="async"${eager ? '' : ' loading="lazy"'}>`
    : '';
  return `<div class="cover" style="--h:${hueOf(title || '')}"><span>${initial}</span>${img}</div>`;
}

// A cover that fails to load is removed, which reveals the lettered fallback behind it.
document.addEventListener('error', (e) => {
  if (e.target.tagName === 'IMG' && e.target.parentElement?.classList.contains('cover')) e.target.remove();
}, true);

const SMART = { liked: 'heart-fill', all: 'note', recent: 'clock' };
const smartCoverHtml = (id) => `<div class="cover smart-${id}">${icon(SMART[id])}</div>`;

// Average colour of a cover, darkened enough for white text to stay readable on it.
const tintCache = new Map();
function coverTint(cover) {
  if (!cover) return Promise.resolve(null);
  if (!tintCache.has(cover)) {
    tintCache.set(cover, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = c.height = 1;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, 1, 1);
          const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
          const scale = Math.min(1, 96 / Math.max(r, g, b, 1));
          resolve(`rgb(${Math.round(r * scale)},${Math.round(g * scale)},${Math.round(b * scale)})`);
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = mediaUrl(cover);
    }));
  }
  return tintCache.get(cover);
}

// ------------------------------------------------------------------ Library

const lib = { status: 'loading', albums: [], tracks: [], byId: new Map() };
const liked = new Set(store.get('encore.liked', []));
let recent = store.get('encore.recent', []);

function indexLibrary(data) {
  lib.albums = (data.albums || []).filter((a) => a.tracks?.length);
  lib.tracks = [];
  lib.byId = new Map();
  for (const album of lib.albums) {
    album.tracks = album.tracks.map((t) => {
      const track = {
        id: t.path,
        src: mediaUrl(t.path),
        title: t.title,
        artist: t.artist || album.artist || 'Unknown artist',
        duration: t.duration,
        album,
        cover: album.cover,
      };
      lib.tracks.push(track);
      lib.byId.set(track.id, track);
      return track;
    });
  }
}

async function loadLibrary() {
  lib.status = 'loading';
  render();
  try {
    const res = await fetch('songs.json', { cache: 'no-cache' });
    if (res.status === 404) {
      indexLibrary({ albums: [] });
    } else if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    } else {
      libraryText = await res.text();
      indexLibrary(JSON.parse(libraryText));
    }
    lib.status = 'ready';
  } catch (err) {
    console.error('Could not load songs.json', err);
    lib.status = 'error';
  }
  restorePlayer();
  render();
}

// Picks up newly uploaded songs without a reload: when the app comes back to the
// foreground, and every minute while it's on screen. Playback is left untouched.
const REFRESH_EVERY_MS = 60 * 1000;
const REFRESH_MIN_GAP_MS = 15 * 1000;
let libraryText = null;
let lastRefresh = 0;

async function refreshLibrary() {
  if (document.visibilityState !== 'visible') return;
  if (Date.now() - lastRefresh < REFRESH_MIN_GAP_MS) return;
  lastRefresh = Date.now();

  // After a failed first load, a normal load also clears the error screen.
  if (lib.status === 'error') {
    loadLibrary();
    return;
  }
  if (lib.status !== 'ready') return;

  let text;
  let data;
  try {
    const res = await fetch('songs.json', { cache: 'no-cache' });
    if (!res.ok) return;
    text = await res.text();
    data = JSON.parse(text);
  } catch {
    return; // offline or mid-deploy: try again next time
  }
  if (text === libraryText) return;

  libraryText = text;
  indexLibrary(data);
  relinkPlayer();

  const top = viewEl.scrollTop;
  if ($('#search-input')) renderSearchResults(); // keeps the keyboard and typed text
  else render();
  viewEl.scrollTop = top;
}

// The library was rebuilt, so point the player at the new track objects.
// A song that was removed keeps playing, and the queue moves on without it.
function relinkPlayer() {
  player.base = player.base.filter((id) => lib.byId.has(id));
  player.queue = player.queue.filter((id) => lib.byId.has(id));
  if (!player.track) return;
  const track = lib.byId.get(player.track.id);
  player.pos = player.queue.indexOf(player.track.id);
  if (track) {
    player.track = track;
    updateTrackUi();
    updateMediaSession();
  }
}

function collection(id) {
  if (id === 'liked') {
    return {
      id, title: 'Liked Songs',
      tracks: lib.tracks.filter((t) => liked.has(t.id)),
      emptyText: 'Tap the heart on a song and it will show up here.',
    };
  }
  if (id === 'all') {
    return { id, title: 'All Songs', tracks: lib.tracks };
  }
  if (id === 'recent') {
    return {
      id, title: 'Recently Played',
      tracks: recent.map((rid) => lib.byId.get(rid)).filter(Boolean),
      emptyText: 'Songs you play will show up here.',
    };
  }
  return null;
}

// ------------------------------------------------------------------ Routing & views

let pageTracks = [];
let pageContext = null;
let currentHash = null;
let hasInAppHistory = false;
let lastTab = 'home';
let searchQuery = '';
const scrollMemory = new Map();

function parseRoute() {
  const [name, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: name || 'home', arg: rest.length ? decodeURIComponent(rest.join('/')) : null };
}

function render() {
  const route = parseRoute();
  pageTracks = [];
  pageContext = null;
  viewEl.style.removeProperty('--page-tint');

  if (route.name === 'home' || route.name === 'search' || route.name === 'library') lastTab = route.name;
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === lastTab));

  if (lib.status === 'loading') viewEl.innerHTML = '';
  else if (lib.status === 'error') viewEl.innerHTML = errorView();
  else if (route.name === 'album') viewEl.innerHTML = albumView(route.arg);
  else if (route.name === 'collection') viewEl.innerHTML = collectionView(route.arg);
  else if (route.name === 'search') renderSearch();
  else if (route.name === 'library') viewEl.innerHTML = libraryView();
  else viewEl.innerHTML = homeView();

  syncPlayerUi();
}

function emptyLibraryHtml() {
  return `<div class="empty">
    <h2>No music yet</h2>
    <p>Upload an album folder to <code>music/</code> in your GitHub repository. It will show up here a minute or two later.</p>
  </div>`;
}

function errorView() {
  return `<div class="page"><div class="empty">
    <h2>Couldn't load your music</h2>
    <p>Check your connection and try again.</p>
    <button class="text-btn" data-action="retry">Try again</button>
  </div></div>`;
}

function albumCard(album) {
  return `<a class="card" href="#/album/${encodeURIComponent(album.id)}">
    <div class="card-cover">${coverHtml(album.cover, album.title)}</div>
    <div class="card-title" dir="auto">${esc(album.title)}</div>
    <div class="card-sub" dir="auto">${esc(album.artist || plural(album.tracks.length, 'song'))}</div>
  </a>`;
}

function collectionCard(id) {
  const c = collection(id);
  return `<a class="card" href="#/collection/${id}">
    <div class="card-cover">${smartCoverHtml(id)}</div>
    <div class="card-title">${esc(c.title)}</div>
    <div class="card-sub">${plural(c.tracks.length, 'song')}</div>
  </a>`;
}

function homeView() {
  const brand = `<div class="brand"><svg aria-hidden="true"><use href="#i-logo"/></svg><h1>${esc(APP_NAME)}</h1></div>`;
  if (!lib.albums.length) return `<div class="page">${brand}${emptyLibraryHtml()}</div>`;

  const seen = new Set();
  const recentAlbums = [];
  for (const id of recent) {
    const album = lib.byId.get(id)?.album;
    if (album && !seen.has(album)) {
      seen.add(album);
      recentAlbums.push(album);
    }
  }
  const shelf = recentAlbums.length
    ? `<h2 class="section-title">Jump back in</h2><div class="shelf">${recentAlbums.slice(0, 10).map(albumCard).join('')}</div>`
    : '';
  const likedCard = liked.size && collection('liked').tracks.length ? collectionCard('liked') : '';

  return `<div class="page">${brand}${shelf}
    <h2 class="section-title">Your music</h2>
    <div class="grid">${likedCard}${lib.albums.map(albumCard).join('')}</div>
  </div>`;
}

function trackRow(track, index, { numbered = false } = {}) {
  const lead = numbered
    ? `<div class="row-num"><span class="num">${index + 1}</span><span class="eq"><i></i><i></i><i></i></span></div>`
    : `<div class="row-thumb">${coverHtml(track.cover, track.album.title)}</div>`;
  const on = liked.has(track.id);
  return `<div class="row track" role="button" tabindex="0" data-action="play-row" data-index="${index}" data-track-id="${esc(track.id)}">
    ${lead}
    <div class="row-text">
      <div class="row-title" dir="auto">${esc(track.title)}</div>
      <div class="row-sub" dir="auto">${esc(numbered ? track.artist : `${track.artist} · ${track.album.title}`)}</div>
    </div>
    <div class="row-time">${fmtTime(track.duration)}</div>
    <button class="icon-btn js-row-like ${on ? 'is-on' : ''}" data-action="like-row" aria-label="${on ? 'Unlike' : 'Like'} ${esc(track.title)}" aria-pressed="${on}">${icon(on ? 'heart-fill' : 'heart')}</button>
  </div>`;
}

function trackPage({ context, coverMarkup, title, artist, tracks, numbered, emptyText, tintFrom }) {
  pageTracks = tracks;
  pageContext = context;
  const meta = [plural(tracks.length, 'song'), fmtTotal(tracks)].filter(Boolean).join(' · ');
  const list = tracks.length
    ? tracks.map((t, i) => trackRow(t, i, { numbered })).join('')
    : `<div class="empty"><p>${esc(emptyText || 'Nothing here yet.')}</p></div>`;
  const actions = tracks.length
    ? `<div class="hero-actions">
        <button class="icon-btn toggle" id="page-shuffle" data-action="shuffle-page" aria-label="Shuffle">${icon('shuffle', 'icon-lg')}</button>
        <button class="play-btn" id="page-play" data-action="play-page" aria-label="Play">${icon('play', 'icon-lg')}</button>
      </div>`
    : '';

  if (tintFrom) {
    coverTint(tintFrom).then((tint) => {
      if (tint && pageContext === context) viewEl.style.setProperty('--page-tint', tint);
    });
  }

  return `<div class="hero"><div class="hero-inner">
      <button class="icon-btn back" data-action="back" aria-label="Back">${icon('back')}</button>
      <div class="hero-cover">${coverMarkup}</div>
      <h1 dir="auto">${esc(title)}</h1>
      <p class="hero-meta" dir="auto">${artist ? `<span class="hero-artist">${esc(artist)}</span> · ` : ''}${meta}</p>
      ${actions}
    </div></div>
    <div class="tracks">${list}</div>`;
}

function notFoundView() {
  return `<div class="page">
    <button class="icon-btn back" data-action="back" aria-label="Back">${icon('back')}</button>
    <div class="empty"><h2>Not found</h2><p>This may have been removed from your library.</p></div>
  </div>`;
}

function albumView(id) {
  const album = lib.albums.find((a) => a.id === id);
  if (!album) return notFoundView();
  return trackPage({
    context: { id: `album:${album.id}`, title: album.title, href: `#/album/${encodeURIComponent(album.id)}` },
    coverMarkup: coverHtml(album.cover, album.title, true),
    title: album.title,
    artist: album.artist,
    tracks: album.tracks,
    numbered: true,
    tintFrom: album.cover,
  });
}

function collectionView(id) {
  const c = collection(id);
  if (!c) return notFoundView();
  return trackPage({
    context: { id: `collection:${id}`, title: c.title, href: `#/collection/${id}` },
    coverMarkup: smartCoverHtml(id),
    title: c.title,
    tracks: c.tracks,
    emptyText: c.emptyText,
  });
}

function libraryRow(href, coverMarkup, title, sub) {
  return `<a class="row" href="${href}">
    <div class="row-thumb">${coverMarkup}</div>
    <div class="row-text">
      <div class="row-title" dir="auto">${esc(title)}</div>
      <div class="row-sub" dir="auto">${esc(sub)}</div>
    </div>
    ${icon('chevron', 'row-chevron')}
  </a>`;
}

function libraryView() {
  const smart = ['liked', 'recent', 'all'].map((id) => {
    const c = collection(id);
    return libraryRow(`#/collection/${id}`, smartCoverHtml(id), c.title, plural(c.tracks.length, 'song'));
  }).join('');
  const albums = lib.albums.map((a) => libraryRow(
    `#/album/${encodeURIComponent(a.id)}`,
    coverHtml(a.cover, a.title),
    a.title,
    [a.artist, plural(a.tracks.length, 'song')].filter(Boolean).join(' · '),
  )).join('');
  return `<div class="page">
    <h1 class="page-title">Library</h1>
    <div class="list-flush">${smart}</div>
    ${albums ? `<h2 class="section-title">Albums</h2><div class="list-flush">${albums}</div>` : ''}
  </div>`;
}

function renderSearch() {
  viewEl.innerHTML = `<div class="page">
    <h1 class="page-title">Search</h1>
    <div class="search-sticky">
      <label class="search-box">
        ${icon('search')}
        <input id="search-input" type="search" placeholder="Songs, albums, artists" aria-label="Search"
          value="${esc(searchQuery)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="search">
      </label>
    </div>
    <div id="search-results"></div>
  </div>`;
  renderSearchResults();
}

function renderSearchResults() {
  const host = $('#search-results');
  if (!host) return;
  const terms = normalize(searchQuery).split(/\s+/).filter(Boolean);

  if (!terms.length) {
    pageTracks = [];
    pageContext = null;
    host.innerHTML = lib.albums.length
      ? `<h2 class="section-title">Browse albums</h2><div class="grid">${lib.albums.map(albumCard).join('')}</div>`
      : emptyLibraryHtml();
    return;
  }

  const matches = (text) => {
    const hay = normalize(text);
    return terms.every((t) => hay.includes(t));
  };
  const albums = lib.albums.filter((a) => matches(`${a.title} ${a.artist || ''}`));
  const tracks = lib.tracks.filter((t) => matches(`${t.title} ${t.artist} ${t.album.title}`)).slice(0, 100);

  pageTracks = tracks;
  pageContext = { id: `search:${searchQuery}`, title: 'Search results', href: '#/search' };

  if (!albums.length && !tracks.length) {
    host.innerHTML = `<div class="empty"><h2>No results</h2><p dir="auto">Nothing matches "${esc(searchQuery)}".</p></div>`;
    return;
  }
  host.innerHTML = `
    ${albums.length ? `<h2 class="section-title">Albums</h2><div class="shelf">${albums.map(albumCard).join('')}</div>` : ''}
    ${tracks.length ? `<h2 class="section-title">Songs</h2><div class="list-flush">${tracks.map((t, i) => trackRow(t, i)).join('')}</div>` : ''}`;
  syncPlayerUi();
}

function onRouteChange() {
  if (currentHash !== null) {
    hasInAppHistory = true;
    scrollMemory.set(currentHash, viewEl.scrollTop);
  }
  currentHash = location.hash || '#/';
  render();
  viewEl.scrollTop = scrollMemory.get(currentHash) || 0;
}

// ------------------------------------------------------------------ Player

const player = {
  track: null,
  base: [],      // track ids in their original order
  queue: [],     // track ids in play order (shuffled when shuffle is on)
  pos: -1,
  context: null,
  shuffle: false,
  repeat: 'off', // off | all | one
  pendingSeek: null,
  wantPlay: false,
  errors: 0,
  scrubbing: false,
  scrubTime: 0,
  restored: false,
  lastSave: 0,
};

function shuffled(items) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildQueue(currentId) {
  if (player.shuffle) {
    player.queue = [currentId, ...shuffled(player.base.filter((id) => id !== currentId))];
    player.pos = 0;
  } else {
    player.queue = player.base.slice();
    player.pos = Math.max(0, player.queue.indexOf(currentId));
  }
}

function playList(tracks, index, context, { shuffle } = {}) {
  if (!tracks.length) return;
  if (shuffle !== undefined) player.shuffle = shuffle;
  player.base = tracks.map((t) => t.id);
  player.context = context;
  buildQueue(tracks[index].id);
  loadTrack(tracks[index], true);
}

function loadTrack(track, autoplay, startAt = 0) {
  player.track = track;
  player.pendingSeek = startAt > 0 ? startAt : null;
  audio.src = track.src;
  updateTrackUi();
  updateMediaSession();
  if (autoplay) {
    addRecent(track.id);
    play();
  }
  saveState(true);
}

function play() {
  player.wantPlay = true;
  const attempt = audio.play();
  attempt?.catch((err) => {
    if (err.name === 'AbortError') return; // a newer track replaced this one
    player.wantPlay = false;
    document.body.classList.remove('is-buffering');
    syncPlayState();
  });
}

function pause() {
  player.wantPlay = false;
  audio.pause();
}

function togglePlay() {
  if (!player.track) return;
  if (audio.paused) play();
  else pause();
}

function next(auto = false) {
  if (!player.queue.length) return;
  if (auto && player.repeat === 'one') {
    seekTo(0);
    play();
    return;
  }
  let pos = player.pos + 1;
  if (pos >= player.queue.length) {
    if (auto && player.repeat !== 'all') {
      // End of the queue: stop on the last song, rewound.
      player.wantPlay = false;
      audio.pause();
      seekTo(0);
      saveState(true);
      return;
    }
    pos = 0;
  }
  goTo(pos);
}

function prev() {
  if (!player.queue.length) return;
  if (currentTime() > 3) {
    seekTo(0);
    return;
  }
  let pos = player.pos - 1;
  if (pos < 0) {
    if (player.repeat !== 'all') {
      seekTo(0);
      return;
    }
    pos = player.queue.length - 1;
  }
  goTo(pos);
}

function goTo(pos) {
  const track = lib.byId.get(player.queue[pos]);
  if (!track) return;
  player.pos = pos;
  loadTrack(track, true);
}

function currentTime() {
  return player.pendingSeek ?? audio.currentTime ?? 0;
}

function currentDuration() {
  return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : player.track?.duration || 0;
}

function seekTo(seconds) {
  const dur = currentDuration();
  const t = Math.max(0, dur ? Math.min(seconds, dur) : seconds);
  if (audio.readyState >= 1) {
    audio.currentTime = t;
    player.pendingSeek = null;
  } else {
    player.pendingSeek = t;
  }
  syncProgress();
  updatePositionState();
}

// iOS ignores currentTime until the file has started loading, so a saved position
// is held back and applied as soon as the browser will accept it.
function applyPendingSeek() {
  if (player.pendingSeek == null || !Number.isFinite(audio.duration)) return;
  const target = Math.min(player.pendingSeek, Math.max(0, audio.duration - 1));
  audio.currentTime = target;
  if (Math.abs(audio.currentTime - target) < 1) player.pendingSeek = null;
}

function toggleShuffle() {
  player.shuffle = !player.shuffle;
  if (player.track) buildQueue(player.track.id);
  syncModes();
  saveState(true);
}

function cycleRepeat() {
  player.repeat = { off: 'all', all: 'one', one: 'off' }[player.repeat];
  syncModes();
  saveState(true);
}

function toggleLike(id) {
  if (liked.has(id)) liked.delete(id);
  else liked.add(id);
  store.set('encore.liked', [...liked]);

  const route = parseRoute();
  if (route.name === 'collection' && route.arg === 'liked') {
    const top = viewEl.scrollTop;
    render();
    viewEl.scrollTop = top;
  } else {
    syncLikes();
  }
}

function addRecent(id) {
  recent = [id, ...recent.filter((r) => r !== id)].slice(0, 50);
  store.set('encore.recent', recent);
}

// ------------------------------------------------------------------ Remember last song

function saveState(force = false) {
  if (!player.track) return;
  const now = Date.now();
  if (!force && now - player.lastSave < 2000) return;
  player.lastSave = now;
  store.set('encore.player', {
    id: player.track.id,
    time: currentTime(),
    base: player.base,
    queue: player.queue,
    pos: player.pos,
    context: player.context,
    shuffle: player.shuffle,
    repeat: player.repeat,
  });
}

function restorePlayer() {
  if (player.restored || lib.status !== 'ready') return;
  player.restored = true;
  const saved = store.get('encore.player', null);
  if (!saved) return;
  player.shuffle = !!saved.shuffle;
  player.repeat = ['off', 'all', 'one'].includes(saved.repeat) ? saved.repeat : 'off';
  syncModes();

  const track = lib.byId.get(saved.id);
  if (!track) return; // the song was removed from the library
  player.base = (saved.base || []).filter((id) => lib.byId.has(id));
  player.queue = (saved.queue || []).filter((id) => lib.byId.has(id));
  if (!player.queue.includes(track.id)) {
    player.base = [track.id];
    player.queue = [track.id];
  }
  player.pos = player.queue.indexOf(track.id);
  player.context = saved.context || null;
  loadTrack(track, false, saved.time || 0);
  syncProgress();
}

// ------------------------------------------------------------------ Lock screen / Control Center

function updateMediaSession() {
  if (!('mediaSession' in navigator) || !player.track) return;
  const t = player.track;
  const src = t.cover ? absUrl(mediaUrl(t.cover)) : absUrl('icons/icon-512.png');
  const ext = src.split('.').pop().toLowerCase();
  const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext] || 'image/jpeg';
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: t.artist,
    album: t.album.title,
    artwork: [{ src, sizes: '512x512', type }],
  });
}

function updatePositionState() {
  if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const duration = audio.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(audio.currentTime, duration),
    });
  } catch { /* an out-of-range value mid-seek is harmless */ }
}

function setupMediaSession() {
  // "playback" tells iOS this is music: it keeps going on lock and ignores the mute switch.
  if (navigator.audioSession) {
    try {
      navigator.audioSession.type = 'playback';
    } catch { /* older iOS */ }
  }
  if (!('mediaSession' in navigator)) return;
  // No seekbackward/seekforward handlers on purpose: iOS would show those buttons
  // in place of next and previous.
  const handlers = {
    play: () => play(),
    pause: () => pause(),
    previoustrack: () => prev(),
    nexttrack: () => next(),
    seekto: (d) => seekTo(d.seekTime),
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, fn);
    } catch { /* action not supported on this device */ }
  }
}

// ------------------------------------------------------------------ Player UI

function updateTrackUi() {
  const t = player.track;
  $('#mini').hidden = !t;
  if (!t) return;
  $('#mini-title').textContent = t.title;
  $('#mini-artist').textContent = t.artist;
  $('#mini-cover').innerHTML = coverHtml(t.cover, t.album.title, true);
  $('#np-art').innerHTML = coverHtml(t.cover, t.album.title, true);
  $('#np-title').textContent = t.title;
  $('#np-artist').textContent = t.artist;
  $('#np-context-title').textContent = player.context?.title || t.album.title;

  coverTint(t.cover).then((tint) => {
    if (player.track !== t) return;
    const root = document.documentElement.style;
    if (tint) {
      root.setProperty('--tint', tint);
      root.setProperty('--mini', tint);
    } else {
      root.removeProperty('--tint');
      root.removeProperty('--mini');
    }
  });
  syncPlayerUi();
}

function syncPlayerUi() {
  syncPlayState();
  syncLikes();
  syncModes();
  syncCurrentRow();
  syncProgress();
}

function isThisPagePlaying() {
  return !!pageContext && player.context?.id === pageContext.id;
}

function syncPlayState() {
  const playing = !audio.paused;
  document.body.classList.toggle('is-playing', playing);
  $$('.js-play').forEach((b) => {
    setIcon(b, playing ? 'pause' : 'play');
    b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  });
  const pageBtn = $('#page-play');
  if (pageBtn) {
    const active = isThisPagePlaying() && playing;
    setIcon(pageBtn, active ? 'pause' : 'play');
    pageBtn.setAttribute('aria-label', active ? 'Pause' : 'Play');
  }
  if ('mediaSession' in navigator && player.track) {
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }
}

function syncLikes() {
  const on = !!player.track && liked.has(player.track.id);
  $$('.js-like').forEach((b) => {
    b.classList.toggle('is-on', on);
    setIcon(b, on ? 'heart-fill' : 'heart');
    b.setAttribute('aria-pressed', on);
    b.setAttribute('aria-label', on ? 'Unlike' : 'Like');
  });
  $$('.track').forEach((row) => {
    const b = row.querySelector('.js-row-like');
    const rowOn = liked.has(row.dataset.trackId);
    b.classList.toggle('is-on', rowOn);
    setIcon(b, rowOn ? 'heart-fill' : 'heart');
    b.setAttribute('aria-pressed', rowOn);
  });
}

function syncModes() {
  const shuffleBtn = $('#btn-shuffle');
  shuffleBtn.classList.toggle('is-on', player.shuffle);
  shuffleBtn.setAttribute('aria-pressed', player.shuffle);

  const repeatBtn = $('#btn-repeat');
  repeatBtn.classList.toggle('is-on', player.repeat !== 'off');
  repeatBtn.setAttribute('aria-pressed', player.repeat !== 'off');
  repeatBtn.setAttribute('aria-label', `Repeat: ${player.repeat}`);
  setIcon(repeatBtn, player.repeat === 'one' ? 'repeat-one' : 'repeat');

  $('#page-shuffle')?.classList.toggle('is-on', player.shuffle && isThisPagePlaying());
}

function syncCurrentRow() {
  const id = player.track?.id;
  $$('.track').forEach((row) => row.classList.toggle('is-current', row.dataset.trackId === id));
}

function syncProgress() {
  const dur = currentDuration();
  const t = player.scrubbing ? player.scrubTime : currentTime();
  const pct = dur ? Math.min(100, (t / dur) * 100) : 0;
  $('#mini-progress-fill').style.transform = `scaleX(${pct / 100})`;
  $('#seek-fill').style.width = `${pct}%`;
  $('#seek-thumb').style.left = `${pct}%`;
  $('#time-now').textContent = fmtTime(t) || '0:00';
  $('#time-total').textContent = fmtTime(dur) || '0:00';
  const seek = $('#seek');
  seek.setAttribute('aria-valuemax', Math.round(dur));
  seek.setAttribute('aria-valuenow', Math.round(t));
  seek.setAttribute('aria-valuetext', `${fmtTime(t) || '0:00'} of ${fmtTime(dur) || '0:00'}`);
}

function setupSeekBar() {
  const seek = $('#seek');
  const timeAt = (e) => {
    const r = seek.getBoundingClientRect();
    return (Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))) * currentDuration();
  };
  seek.addEventListener('pointerdown', (e) => {
    if (!currentDuration()) return;
    seek.setPointerCapture(e.pointerId);
    player.scrubbing = true;
    player.scrubTime = timeAt(e);
    seek.classList.add('is-scrubbing');
    syncProgress();
  });
  seek.addEventListener('pointermove', (e) => {
    if (!player.scrubbing) return;
    player.scrubTime = timeAt(e);
    syncProgress();
  });
  const finish = (commit) => {
    if (!player.scrubbing) return;
    player.scrubbing = false;
    seek.classList.remove('is-scrubbing');
    if (commit) seekTo(player.scrubTime);
    saveState(true);
  };
  seek.addEventListener('pointerup', () => finish(true));
  seek.addEventListener('pointercancel', () => finish(false));
  seek.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5 }[e.key];
    if (!step) return;
    e.preventDefault();
    seekTo(currentTime() + step);
  });
}

// ------------------------------------------------------------------ Now Playing sheet

function openNowPlaying() {
  const np = $('#np');
  np.classList.add('is-open');
  np.inert = false;
  $('#app').inert = true;
}

function closeNowPlaying() {
  const np = $('#np');
  np.classList.remove('is-open');
  np.inert = true;
  $('#app').inert = false;
}

function setupSwipeToClose() {
  const zone = $('#np-swipe');
  const np = $('#np');
  let startY = null;
  let dy = 0;
  zone.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    startY = e.clientY;
    dy = 0;
    zone.setPointerCapture(e.pointerId);
    np.style.transition = 'none';
  });
  zone.addEventListener('pointermove', (e) => {
    if (startY == null) return;
    dy = Math.max(0, e.clientY - startY);
    np.style.transform = `translateY(${dy}px)`;
  });
  const end = (commit) => {
    if (startY == null) return;
    startY = null;
    np.style.transition = '';
    np.style.transform = '';
    if (commit && dy > 110) closeNowPlaying();
  };
  zone.addEventListener('pointerup', () => end(true));
  zone.addEventListener('pointercancel', () => end(false));
}

// ------------------------------------------------------------------ Audio events

function setupAudioEvents() {
  audio.addEventListener('play', syncPlayState);
  audio.addEventListener('pause', () => {
    syncPlayState();
    updatePositionState();
    saveState(true);
  });
  audio.addEventListener('playing', () => {
    player.errors = 0;
    document.body.classList.remove('is-buffering');
    applyPendingSeek();
    syncPlayState();
    updatePositionState();
  });
  audio.addEventListener('waiting', () => {
    if (player.wantPlay) document.body.classList.add('is-buffering');
  });
  audio.addEventListener('loadedmetadata', () => {
    applyPendingSeek();
    syncProgress();
    updatePositionState();
  });
  audio.addEventListener('canplay', () => {
    document.body.classList.remove('is-buffering');
    applyPendingSeek();
  });
  audio.addEventListener('durationchange', () => {
    syncProgress();
    updatePositionState();
  });
  audio.addEventListener('seeked', () => {
    updatePositionState();
    saveState(true);
  });
  audio.addEventListener('timeupdate', () => {
    syncProgress();
    saveState();
  });
  // Starting the next song right here, inside the event, is what lets the queue
  // keep moving while the phone is locked.
  audio.addEventListener('ended', () => next(true));
  audio.addEventListener('error', () => {
    if (!audio.getAttribute('src') || !player.track) return;
    document.body.classList.remove('is-buffering');
    if (!player.wantPlay) return;
    player.errors += 1;
    toast(navigator.onLine === false ? "You're offline" : `Couldn't play "${player.track.title}"`);
    if (navigator.onLine !== false && player.errors < 3 && player.queue.length > 1) {
      next();
    } else {
      player.wantPlay = false;
      syncPlayState();
    }
  });
}

// ------------------------------------------------------------------ Tap handling

const actions = {
  'open-np': () => openNowPlaying(),
  'close-np': () => closeNowPlaying(),
  'toggle-play': () => togglePlay(),
  next: () => next(),
  prev: () => prev(),
  'toggle-shuffle': () => toggleShuffle(),
  'cycle-repeat': () => cycleRepeat(),
  'like-current': () => player.track && toggleLike(player.track.id),
  'like-row': (el) => toggleLike(el.closest('.track').dataset.trackId),
  'play-row': (el) => {
    const index = Number(el.dataset.index);
    const track = pageTracks[index];
    if (track?.id === player.track?.id && isThisPagePlaying()) togglePlay();
    else playList(pageTracks, index, pageContext);
  },
  'play-page': () => {
    if (isThisPagePlaying()) togglePlay();
    else playList(pageTracks, 0, pageContext, { shuffle: false });
  },
  'shuffle-page': () => {
    const index = Math.floor(Math.random() * pageTracks.length);
    playList(pageTracks, index, pageContext, { shuffle: true });
  },
  back: () => {
    if (hasInAppHistory) history.back();
    else location.hash = '#/';
  },
  'open-context': () => {
    const target = player.context?.href
      || (player.track ? `#/album/${encodeURIComponent(player.track.album.id)}` : null);
    closeNowPlaying();
    if (target && target !== location.hash) location.hash = target;
  },
  tab: (el, e) => {
    // Tapping the tab you're already on scrolls back to the top.
    if ((location.hash || '#/') === el.getAttribute('href')) {
      e.preventDefault();
      viewEl.scrollTo({ top: 0, behavior: 'smooth' });
    }
  },
  retry: () => loadLibrary(),
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el) actions[el.dataset.action]?.(el, e);
});

document.addEventListener('keydown', (e) => {
  if (e.target.matches?.('input')) return;
  if (e.key === 'Escape') closeNowPlaying();
  const isRowLike = e.target.matches?.('.row[role="button"], #mini');
  if (isRowLike && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    e.target.click();
  } else if (e.key === ' ' && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'A') {
    e.preventDefault();
    togglePlay();
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id !== 'search-input') return;
  searchQuery = e.target.value;
  renderSearchResults();
});

// ------------------------------------------------------------------ Start

window.addEventListener('hashchange', onRouteChange);
window.addEventListener('pagehide', () => saveState(true));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveState(true);
  else refreshLibrary();
});
window.addEventListener('online', refreshLibrary);
setInterval(refreshLibrary, REFRESH_EVERY_MS);

setupAudioEvents();
setupMediaSession();
setupSeekBar();
setupSwipeToClose();
currentHash = location.hash || '#/';
loadLibrary();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker not registered', err));
  });
}
