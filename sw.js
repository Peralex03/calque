/* Calque : app disponible hors ligne + cache des tuiles swisstopo consultées. Aucune donnée de plan ne passe ici. */
const SHELL_CACHE = 'calque-shell-v9';
const TILE_CACHE = 'calque-tiles';
const DATA_CACHE = 'calque-data';
const MOD_CACHE = 'calque-mod-v1';   /* modules lourds chargés à la demande : lecture de texte, PDF */
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== TILE_CACHE && k !== DATA_CACHE && k !== MOD_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.hostname === 'wmts.geo.admin.ch') { e.respondWith(tile(req)); return; }
  if (u.hostname === 'api3.geo.admin.ch' && u.pathname.endsWith('/identify')) { e.respondWith(data(req)); return; }
  if (u.origin === self.location.origin && /\/(ocr|pdf)\/[^/]+$/.test(u.pathname)) { e.respondWith(mod(req)); return; }
  if (u.origin === self.location.origin) e.respondWith(shell(req));
});

async function tile(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  try {
    const res = await fetch(req.url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (res.ok) cache.put(req.url, res.clone());
    return res;
  } catch (err) {
    try { return await fetch(req); } catch (err2) { return new Response('', { status: 504 }); }
  }
}

/* routes et itinéraires des chars : gardés 30 jours sur l'appareil (calcul rapide, utilisable hors ligne) */
const DATA_TTL = 30 * 864e5;
async function data(req) {
  const cache = await caches.open(DATA_CACHE);
  const hit = await cache.match(req.url);
  if (hit && Date.now() - (+hit.headers.get('x-calque-t') || 0) < DATA_TTL) return hit;
  try {
    const res = await fetch(req.url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (res.ok) {
      const body = await res.clone().blob(), hd = new Headers({ 'Content-Type': res.headers.get('Content-Type') || 'application/json', 'x-calque-t': String(Date.now()) });
      cache.put(req.url, new Response(body, { status: 200, headers: hd }));
    }
    return res;
  } catch (err) {
    return hit || new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

async function shell(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') cache.put(req.mode === 'navigate' ? './index.html' : req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') return (await cache.match('./index.html')) || (await cache.match('./'));
    return new Response('', { status: 504 });
  }
}

/* modules : premier téléchargement puis lecture hors ligne */
async function mod(req) {
  const cache = await caches.open(MOD_CACHE);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await fetch(req.url);
  if (res.ok) cache.put(req.url, res.clone());
  return res;
}
