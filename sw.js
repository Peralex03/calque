/* Calque : service worker. Aucune donnée de plan ne passe ici.
   - pare-feu de sortie : rien ne quitte l'appareil hors de l'app elle-même et de geo.admin.ch, y compris depuis les
     modules de lecture (workers), que la CSP de la page ne couvre pas ;
   - coquille servie depuis le cache : une nouvelle version est téléchargée et vérifiée en arrière-plan, mais n'est
     employée qu'après accord de l'utilisateur (bandeau « Mettre à jour ») ;
   - modules ocr/ et pdf/ servis seulement si leur empreinte est celle de la version acceptée ;
   - « hors ligne strict » : plus aucune requête, tout vient des caches.
   Ce fichier ne change pas d'une version de l'app à l'autre : la version (empreintes de index.html et des modules)
   est décrite par version.json, écrit par build.mjs. */
/* version du code de ce fichier : la page vérifie qu'elle est servie par un service worker qui connaît ce qu'elle
   demande (2 : réseau routier embarqué) */
const SW_CODE = 2;
const SHELL_PREFIX = 'calque-shell-';
const TILE_CACHE = 'calque-tiles';
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
  const keep = new Set([TILE_CACHE, MOD_CACHE, CFG_CACHE, NET_CACHE]);   /* l'ancien cache des routes de l'API part au ménage */
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
    /* mise à jour de ce seul fichier : la version acceptée et ses caches ne bougent pas, le nouveau code prend la main
       tout de suite. Sinon il attendrait que l'app soit fermée partout, ce qui n'arrive presque jamais sur iPhone, et
       la page à jour serait servie par l'ancien code. */
    if (c && await (await caches.open(SHELL_PREFIX + c.build)).match(abs('index.html'))) { await self.skipWaiting(); return; }
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
    else if (kind === 'wms' || kind === 'search') e.respondWith(pass(req));
    else e.respondWith(Response.error());
    return;
  }
  if (!req.url.startsWith(SCOPE)) { e.respondWith(Response.error()); return; }
  const rel = u.pathname.slice(new URL(SCOPE).pathname.length);
  if (/^(ocr|pdf)\//.test(rel) || rel === 'net/index.json' || rel === 'net/fond.bin') { e.respondWith(mod(rel)); return; }
  if (NET_TILE.test(rel)) { e.respondWith(netTile(rel, u.searchParams.get('h') || '')); return; }
  e.respondWith(shell(req, rel));
});

/* couches officielles et recherche de lieu : jamais gardées, sans cookies ni référent */
async function pass(req) {
  if (await strict()) return new Response('', { status: 504 });
  try { return await fetch(req.url, { mode: req.mode === 'no-cors' ? 'no-cors' : 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' }); }
  catch (err) { return new Response('', { status: 504 }); }
}

/* tuiles : cache borné, sans embouteillage. Une écriture ou une suppression bloque le cache le temps qu'elle dure :
   un seul écrivain à la fois, en file, et les lectures des tuiles affichées passent entre deux. Le cache est compté une
   fois par réveil, puis tenu à jour ; au-delà de TILE_MAX, les plus anciennes partent d'un coup jusqu'à TILE_KEEP, par
   petits paquets, un seul ménage à la fois (avant : un ménage complet toutes les 100 tuiles, qui se chevauchaient et
   figeaient la carte sur grand écran). */
const TILE_KEEP = 7000;
let tileN = -1, countP = null, trimming = false;
const wq = [];
let wBusy = false;
function wqPush(job, force) {
  if (!force && wq.length >= 1000) return false;   /* garder en cache n'est qu'un plus : au-delà, on laisse passer */
  wq.push(job);
  if (!wBusy) wqRun();
  return true;
}
async function wqRun() {
  wBusy = true;
  while (wq.length) { const job = wq.shift(); try { await job(); } catch (e) {} }
  wBusy = false;
}
const tilesCounted = cache => countP || (countP = cache.keys().then(k => { tileN = k.length; }, () => { tileN = 0; }));
async function trimTiles(cache) {
  if (trimming || tileN <= TILE_MAX) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    tileN = keys.length;
    const drop = keys.slice(0, Math.max(0, keys.length - TILE_KEEP));   /* les plus anciennes d'abord */
    for (let i = 0; i < drop.length; i += 25) {
      const part = drop.slice(i, i + 25);
      await new Promise(res => wqPush(async () => { try { await Promise.all(part.map(k => cache.delete(k))); tileN -= part.length; } finally { res(); } }, true));
    }
  } catch (e) {} finally { trimming = false; }
}
/* keep : tuile demandée par « Garder la zone hors ligne » (en-tête x-calque-keep) : rangée avant la réponse, jamais
   laissée de côté, pour que la zone annoncée gardée le soit vraiment. Les tuiles de la carte affichée, elles, partent
   tout de suite vers la page ; leur rangement suit dans la file. */
async function tile(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  if (await strict()) return new Response('', { status: 504 });
  const keep = req.headers.get('x-calque-keep') === '1';
  try {
    /* une tuile que la page ne veut plus (carte déplacée) n'est pas téléchargée jusqu'au bout */
    const res = await fetch(req.url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal: keep ? undefined : req.signal });
    if (res.ok) {
      const copy = res.clone();
      const put = () => new Promise(done => {
        const queued = wqPush(async () => {
          try {
            await tilesCounted(cache);
            await cache.put(req.url, copy);
            tileN++;
            if (tileN > TILE_MAX) trimTiles(cache);   /* sans attendre : le ménage passe lui-même par la file */
          } finally { done(); }
        }, keep);
        if (!queued) done();
      });
      if (keep) await put(); else put();
    }
    return res;
  } catch (err) { return new Response('', { status: 504 }); }
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

/* réseau routier, cases locales : la page annonce l'empreinte que l'index (lui-même vérifié) donne à la case ;
   la case n'est rendue que si elle y correspond, puis gardée. Rien d'autre que ce fichier n'est demandé. */
const NET_TILE = /^net\/l\/-?\d+_-?\d+\.bin$/, NET_CACHE = 'calque-net-v1';
async function netTile(rel, want) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(want)) return new Response('', { status: 403, statusText: 'empreinte' });
  const cache = await caches.open(NET_CACHE), key = abs(rel);
  const hit = await cache.match(key);
  if (hit && hit.headers.get('x-calque-h') === want) return hit;
  if (await strict()) return new Response('', { status: 504 });
  let res;
  try { res = await fetch(key, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }); }
  catch (err) { return new Response('', { status: 504 }); }
  if (!res.ok) return new Response('', { status: res.status });
  const buf = await res.arrayBuffer();
  if (await sha(buf) !== want) return new Response('', { status: 502, statusText: 'integrite' });
  const hd = { 'Content-Type': 'application/octet-stream', 'x-calque-h': want };
  cache.put(key, new Response(buf, { status: 200, headers: hd })).catch(() => {});
  return new Response(buf, { status: 200, headers: hd });
}

/* modules de lecture : seuls les fichiers prévus par le build, et seulement si leur empreinte est la bonne */
const modType = rel => rel.endsWith('.js') ? 'application/javascript' : rel.endsWith('.json') ? 'application/json' : 'application/octet-stream';
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
const status = async () => { const c = await current(), n = await pending(); return { sw: SW_CODE, build: c ? c.build : '', next: n ? n.build : '', strict: await strict(), mods: await modsReady(), modsTotal: c ? c.preload.length : 0 }; };

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
  else if (d.t === 'skip') e.waitUntil(self.skipWaiting().then(status).then(reply));
  else if (d.t === 'precache') e.waitUntil(strict().then(s => s ? null : precache()).then(status).then(reply));
});
