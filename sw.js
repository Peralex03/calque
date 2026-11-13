/* Calque : service worker. Aucune donnée de plan ne passe ici.
   - pare-feu de sortie : rien ne quitte l'appareil hors de l'app elle-même et de geo.admin.ch, y compris depuis les
     modules de lecture (workers), que la CSP de la page ne couvre pas ;
   - coquille servie depuis le cache : une nouvelle version est téléchargée et vérifiée en arrière-plan, mais n'est
     employée qu'après accord de l'utilisateur (bandeau « Mettre à jour ») ;
   - modules ocr/ et pdf/ servis seulement si leur empreinte est celle de la version acceptée ;
   - « hors ligne strict » : plus aucune requête, tout vient des caches.
   Ce fichier ne change pas d'une version de l'app à l'autre : la version (empreintes de index.html et des modules)
   est décrite par version.json, écrit par build.mjs. */
const SHELL_PREFIX = 'calque-shell-';
const TILE_CACHE = 'calque-tiles';
const DATA_CACHE = 'calque-data';
const MOD_CACHE = 'calque-mod-v2';
const CFG_CACHE = 'calque-cfg';
const ASSETS = ['./manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './favicon-32.png'];
const TILE_MAX = 8000;
const SCOPE = self.registration.scope;
const abs = p => new URL(p, SCOPE).href;
const sha = async buf => { const b = new Uint8Array(await crypto.subtle.digest('SHA-256', buf)); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/* ---------- réglages gardés entre deux réveils du service worker ---------- */
const cfgGet = async k => { try { const r = await (await caches.open(CFG_CACHE)).match(abs('__cfg/' + k)); return r ? await r.text() : ''; } catch (e) { return ''; } };
const cfgSet = async (k, v) => (await caches.open(CFG_CACHE)).put(abs('__cfg/' + k), new Response(String(v)));
let strictP = null, curP = null;
const strict = () => strictP || (strictP = cfgGet('strict').then(v => v === '1'));

/* ---------- versions : { build, index, mods: { chemin: empreinte }, preload: [chemins] } ---------- */
const okVer = m => !!m && typeof m === 'object' && /^[0-9a-f]{16}$/.test(m.build) && typeof m.index === 'string' && !!m.mods && typeof m.mods === 'object' && Array.isArray(m.preload);
const parseVer = t => { try { const m = JSON.parse(t); return okVer(m) ? m : null; } catch (e) { return null; } };
/* version acceptée par l'utilisateur : c'est elle, et elle seule, qui est servie */
const current = () => curP || (curP = cfgGet('version').then(parseVer));
const pending = async () => { const n = parseVer(await cfgGet('next')), c = await current(); return n && c && n.build !== c.build && await caches.has(SHELL_PREFIX + n.build) ? n : null; };
async function fetchVersion() {
  const res = await fetch(abs('version.json'), { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  const m = res.ok ? parseVer(await res.text()) : null;
  if (!m) throw new Error('version');
  return m;
}
/* télécharge la coquille d'une version dans son propre cache, après contrôle de l'empreinte de index.html */
async function stage(m) {
  const c = await caches.open(SHELL_PREFIX + m.build);
  if (await c.match(abs('index.html'))) return;
  try {
    const res = await fetch(abs('index.html'), { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error('coquille');
    const buf = await res.arrayBuffer();
    if (await sha(buf) !== m.index) throw new Error('integrite');
    await c.addAll(ASSETS.map(u => new Request(abs(u), { cache: 'no-store', credentials: 'omit' })));
    const page = () => new Response(buf, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    await c.put(abs('./'), page()); await c.put(abs('index.html'), page());   /* en dernier : sa présence vaut « coquille complète » */
  } catch (e) { await caches.delete(SHELL_PREFIX + m.build); throw e; }
}
async function cleanup() {
  const c = await current(), n = await pending();
  const keep = new Set([TILE_CACHE, DATA_CACHE, MOD_CACHE, CFG_CACHE]);
  if (c) keep.add(SHELL_PREFIX + c.build);
  if (n) keep.add(SHELL_PREFIX + n.build);
  for (const k of await caches.keys()) if (k.startsWith('calque-') && !keep.has(k)) await caches.delete(k);
}
/* vérification en arrière-plan : une version publiée est téléchargée et vérifiée, puis attend l'accord */
let checkP = null;
function check() {
  return checkP || (checkP = (async () => {
    if (await strict()) return;
    const m = await fetchVersion(), c = await current();
    if (c && m.build === c.build) { await cfgSet('next', ''); return; }
    await stage(m);
    await cfgSet('next', JSON.stringify(m));
  })().catch(() => {}).finally(() => { checkP = null; }));
}
async function accept() {
  const n = await pending();
  if (!n) return;
  await cfgSet('version', JSON.stringify(n)); curP = Promise.resolve(n);
  await cfgSet('next', '');
  await cleanup();
}

/* ---------- installation : première version, vérifiée ; rien à confirmer puisqu'il n'y en a pas d'autre ---------- */
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await current();
    if (c && await (await caches.open(SHELL_PREFIX + c.build)).match(abs('index.html'))) return;   /* mise à jour de ce seul fichier */
    const m = await fetchVersion();
    await stage(m);
    await cfgSet('version', JSON.stringify(m)); curP = Promise.resolve(m);
    /* première installation, ou relève d'un ancien service worker (d'avant les mises à jour confirmées) : prendre la
       main tout de suite. Sinon l'ancien continuerait à servir l'ancienne app hors ligne jusqu'à la fermeture complète. */
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => { await cleanup(); await self.clients.claim(); })());
});

/* ---------- pare-feu de sortie ---------- */
function egress(u) {
  if (u.protocol !== 'https:') return '';
  if (u.hostname === 'wmts.geo.admin.ch') return u.pathname.startsWith('/1.0.0/') && !u.search ? 'tile' : '';
  if (u.hostname === 'wms.geo.admin.ch') return 'wms';
  if (u.hostname === 'api3.geo.admin.ch') {
    if (u.pathname === '/rest/services/api/MapServer/identify') return 'data';
    if (u.pathname === '/rest/services/api/SearchServer') return 'search';
  }
  return '';
}
self.addEventListener('fetch', e => {
  const req = e.request;
  let u;
  try { u = new URL(req.url); } catch (err) { e.respondWith(Response.error()); return; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
  if (req.method !== 'GET') { e.respondWith(Response.error()); return; }
  if (u.origin !== self.location.origin) {
    const kind = egress(u);
    if (kind === 'tile') e.respondWith(tile(req));
    else if (kind === 'data') e.respondWith(data(req));
    else if (kind === 'wms' || kind === 'search') e.respondWith(pass(req));
    else e.respondWith(Response.error());
    return;
  }
  if (!req.url.startsWith(SCOPE)) { e.respondWith(Response.error()); return; }
  const rel = u.pathname.slice(new URL(SCOPE).pathname.length);
  if (/^(ocr|pdf)\//.test(rel)) { e.respondWith(mod(rel)); return; }
  e.respondWith(shell(req, rel));
});

/* couches officielles et recherche de lieu : jamais gardées, sans cookies ni référent */
async function pass(req) {
  if (await strict()) return new Response('', { status: 504 });
  try { return await fetch(req.url, { mode: req.mode === 'no-cors' ? 'no-cors' : 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' }); }
  catch (err) { return new Response('', { status: 504 }); }
}

let puts = 0;
async function trimTiles(cache) {
  if (++puts % 100) return;
  const keys = await cache.keys();
  if (keys.length <= TILE_MAX) return;
  for (const k of keys.slice(0, keys.length - TILE_MAX + 200)) await cache.delete(k);   /* les plus anciennes d'abord */
}
async function tile(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  if (await strict()) return new Response('', { status: 504 });
  try {
    const res = await fetch(req.url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (res.ok) cache.put(req.url, res.clone()).then(() => trimTiles(cache)).catch(() => {});
    return res;
  } catch (err) { return new Response('', { status: 504 }); }
}

/* routes et itinéraires des chars : gardés 30 jours sur l'appareil (calcul rapide, utilisable hors ligne) */
const DATA_TTL = 30 * 864e5;
async function data(req) {
  const cache = await caches.open(DATA_CACHE);
  const hit = await cache.match(req.url);
  const off = () => new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  if (await strict()) return hit || off();
  if (hit && Date.now() - (+hit.headers.get('x-calque-t') || 0) < DATA_TTL) return hit;
  try {
    const res = await fetch(req.url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (res.ok) {
      const body = await res.clone().blob(), hd = new Headers({ 'Content-Type': res.headers.get('Content-Type') || 'application/json', 'x-calque-t': String(Date.now()) });
      cache.put(req.url, new Response(body, { status: 200, headers: hd })).catch(() => {});
    }
    return res;
  } catch (err) { return hit || off(); }
}

/* coquille : toujours le cache de la version acceptée. Le réseau seulement pour un fichier connu que le cache n'a
   pas (icônes, écrans de lancement) : aucune autre adresse de l'hébergeur ne peut être appelée, donc rien n'y part. */
const KNOWN = /^(index\.html|confidentialite\.html|manifest\.webmanifest|favicon-32\.png|icon-[a-z0-9-]+\.png|splash-\d+x\d+\.png)?$/;
async function shell(req, rel) {
  const nav = req.mode === 'navigate' && (rel === '' || rel === 'index.html');
  const key = nav ? abs('index.html') : abs(rel);
  const cur = await current();
  if (cur) { const hit = await (await caches.open(SHELL_PREFIX + cur.build)).match(key); if (hit) return hit; }
  if (!KNOWN.test(rel)) return new Response('', { status: 404 });
  if (await strict()) return new Response('', { status: 504 });
  try { return await fetch(key, { credentials: 'omit', referrerPolicy: 'no-referrer' }); }   /* sans paramètres : rien ne part dans l'adresse */
  catch (err) { return new Response('', { status: 504 }); }
}

/* modules de lecture : seuls les fichiers prévus par le build, et seulement si leur empreinte est la bonne */
const modType = rel => rel.endsWith('.js') ? 'application/javascript' : 'application/octet-stream';
async function mod(rel) {
  const cur = await current(), want = cur && own(cur.mods, rel) ? cur.mods[rel] : null;
  if (typeof want !== 'string') return new Response('', { status: 403, statusText: 'module inconnu' });
  const cache = await caches.open(MOD_CACHE), key = abs(rel);
  const hit = await cache.match(key);
  if (hit && hit.headers.get('x-calque-h') === want) return hit;
  if (await strict()) return new Response('', { status: 504 });
  let res;
  try { res = await fetch(key, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }); }
  catch (err) { return new Response('', { status: 504 }); }
  if (!res.ok) return new Response('', { status: res.status });
  const buf = await res.arrayBuffer();
  if (await sha(buf) !== want) return new Response('', { status: 502, statusText: 'integrite' });
  const hd = { 'Content-Type': modType(rel), 'x-calque-h': want };
  await cache.put(key, new Response(buf, { status: 200, headers: hd }));
  return new Response(buf, { status: 200, headers: hd });
}
async function modsReady() {
  const cur = await current(), cache = await caches.open(MOD_CACHE);
  let n = 0;
  for (const rel of (cur ? cur.preload : [])) { const hit = await cache.match(abs(rel)); if (hit && hit.headers.get('x-calque-h') === cur.mods[rel]) n++; }
  return n;
}
/* téléchargement d'avance : la lecture de texte et de PDF marche ensuite sans réseau, sans premier usage en ligne */
let preP = null;
function precache() {
  return preP || (preP = (async () => {
    const cur = await current();
    if (!cur) return;
    for (const rel of cur.preload) { try { await mod(String(rel)); } catch (e) {} }
    const cache = await caches.open(MOD_CACHE);   /* ménage : fichiers d'une version précédente */
    for (const k of await cache.keys()) { const rel = k.url.slice(SCOPE.length); const r = await cache.match(k); if (!r || !own(cur.mods, rel) || r.headers.get('x-calque-h') !== cur.mods[rel]) await cache.delete(k); }
  })().finally(() => { preP = null; }));
}
const status = async () => { const c = await current(), n = await pending(); return { build: c ? c.build : '', next: n ? n.build : '', strict: await strict(), mods: await modsReady(), modsTotal: c ? c.preload.length : 0 }; };

/* ---------- ordres de la page ---------- */
self.addEventListener('message', e => {
  const d = e.data || {}, port = e.ports && e.ports[0];
  const src = e.source;
  if (!src || !src.url || new URL(src.url).origin !== self.location.origin) return;
  const reply = v => { if (port) port.postMessage(v); };
  if (d.t === 'strict') e.waitUntil(cfgSet('strict', d.v ? '1' : '0').then(() => { strictP = Promise.resolve(!!d.v); }).then(status).then(reply));
  else if (d.t === 'accept') e.waitUntil(accept().then(status).then(reply));
  else if (d.t === 'check') e.waitUntil(check().then(status).then(reply));
  else if (d.t === 'status') e.waitUntil(status().then(reply));
  else if (d.t === 'precache') e.waitUntil(strict().then(s => s ? null : precache()).then(status).then(reply));
});
