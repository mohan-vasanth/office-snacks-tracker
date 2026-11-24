// PWA checks. Run `npm run build` first, then `npm run test:pwa` (uses Node's built-in test runner, no extra packages).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..'), dist = join(root, 'dist');
const read = (p) => readFileSync(join(dist, p), 'utf8');
const pngSize = (p) => { const b = readFileSync(join(dist, p)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

test('build output exists', () => assert.ok(existsSync(join(dist, 'sw.js')), 'run npm run build first'));

test('manifest has required fields and icons', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.name, 'Office Snacks Tracker'); assert.equal(m.short_name, 'Snacks Tracker');
  assert.equal(m.display, 'standalone'); assert.ok(m.start_url && m.scope && m.theme_color && m.background_color);
  for (const size of [192, 512]) {
    assert.ok(m.icons.some((i) => i.sizes === `${size}x${size}` && i.purpose === 'any'), `any ${size}`);
    assert.ok(m.icons.some((i) => i.sizes === `${size}x${size}` && i.purpose === 'maskable'), `maskable ${size}`);
  }
  for (const i of m.icons) { assert.ok(existsSync(join(dist, i.src)), i.src); assert.deepEqual(pngSize(i.src), i.sizes.split('x').map(Number)); }
  assert.deepEqual(pngSize('icons/apple-touch-icon.png'), [180, 180]);
});

test('index.html links manifest and Apple metadata', () => {
  const h = read('index.html');
  for (const s of ['rel="manifest"', 'apple-touch-icon', 'apple-mobile-web-app-capable', 'apple-mobile-web-app-title', 'name="theme-color"']) assert.ok(h.includes(s), s);
});

test('service worker is stamped with a build id and precache list covering built assets', () => {
  const sw = read('sw.js');
  assert.ok(!sw.includes("'__BUILD_ID__'")); assert.ok(!sw.includes('/*__PRECACHE__*/[]'));
  const list = JSON.parse(/const PRECACHE = (\[.*\]);/.exec(sw)[1]);
  for (const f of ['index.html', 'offline.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png']) assert.ok(list.includes(f), f);
  assert.ok(list.some((f) => /^assets\/index-.*\.js$/.test(f)) && list.some((f) => /^assets\/.*\.css$/.test(f)));
  assert.ok(!list.includes('sw.js'));
});

// Run the real sw.js against a fake worker environment.
function loadSw() {
  const listeners = {}, store = new Map(), fetchCalls = [];
  const cacheApi = {
    async open(name) { if (!store.has(name)) store.set(name, new Map()); const c = store.get(name); return { put: async (r, res) => { c.set(typeof r === 'string' ? r : r.url, res); }, match: async (r) => c.get(typeof r === 'string' ? r : r.url), addAll: async (rs) => { for (const r of rs) c.set(r.url, { ok: true }); } }; },
    async keys() { return [...store.keys()]; }, async delete(k) { return store.delete(k); },
    async match(r) { const u = typeof r === 'string' ? r : r.url; for (const c of store.values()) if (c.has(u)) return c.get(u); },
  };
  const env = { online: true };
  const self = { registration: { scope: 'https://app.test/' }, location: { origin: 'https://app.test' }, clients: { claim: async () => {} }, skipWaiting() { self.skipped = true; }, addEventListener: (t, f) => { listeners[t] = f; } };
  const ctx = vm.createContext({ self, caches: cacheApi, URL, Request: class { constructor(u) { this.url = u; } }, Response: { error: () => ({ error: true }) },
    fetch: async (r) => { fetchCalls.push(r.url); if (!env.online) throw new TypeError('offline'); return { ok: true, type: 'basic', headers: new Map(), clone() { return this; } }; } });
  vm.runInContext(readFileSync(join(dist, 'sw.js'), 'utf8'), ctx);
  const dispatch = (request) => { let handled = null; listeners.fetch({ request, respondWith: (p) => { handled = p; } }); return handled; };
  return { listeners, store, env, fetchCalls, dispatch, self };
}
const req = (url, o = {}) => ({ url, method: 'GET', mode: 'cors', ...o });

test('SW ignores Supabase / cross-origin / non-GET requests so sensitive data is never cached', async () => {
  const sw = loadSw();
  assert.equal(sw.dispatch(req('https://abc.supabase.co/rest/v1/snack_records?select=*')), null);
  assert.equal(sw.dispatch(req('https://abc.supabase.co/auth/v1/token', { method: 'POST' })), null);
  assert.equal(sw.dispatch(req('https://app.test/assets/x.js', { method: 'POST' })), null);
  assert.equal(sw.dispatch(req('https://app.test/api/records')), null);
  assert.equal(sw.fetchCalls.length, 0);
});

test('SW serves cached shell for navigations when offline, offline page as last resort', async () => {
  const sw = loadSw();
  await sw.listeners.install({ waitUntil: (p) => p });
  await (await caches_open(sw)).put('https://app.test/index.html', { ok: true, marker: 'shell' });
  sw.env.online = false;
  const res = await sw.dispatch(req('https://app.test/', { mode: 'navigate' }));
  assert.equal(res.marker, 'shell');
});
const caches_open = async (sw) => { const name = [...sw.store.keys()][0]; return { put: async (k, v) => sw.store.get(name).set(k, v) }; };

test('SW activation deletes outdated snacks-* caches only', async () => {
  const sw = loadSw();
  sw.store.set('snacks-shell-old', new Map()); sw.store.set('other-app', new Map());
  await new Promise((resolve) => sw.listeners.activate({ waitUntil: (p) => p.then(resolve) }));
  assert.ok(!sw.store.has('snacks-shell-old')); assert.ok(sw.store.has('other-app'));
});

test('SW waits for the page before activating an update (no automatic skipWaiting)', () => {
  const sw = loadSw();
  sw.listeners.install({ waitUntil: () => {} });
  assert.ok(!sw.self.skipped);
  sw.listeners.message({ data: { type: 'SKIP_WAITING' } });
  assert.ok(sw.self.skipped);
});

test('manifest screenshots exist with correct dimensions, type and form factor', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.screenshots.length, 2);
  const wide = m.screenshots.filter((s) => s.form_factor === 'wide'), other = m.screenshots.filter((s) => !s.form_factor || s.form_factor === 'narrow');
  assert.equal(wide.length, 1); assert.equal(other.length, 1);
  for (const s of m.screenshots) { assert.equal(s.type, 'image/png'); assert.deepEqual(pngSize(s.src), s.sizes.split('x').map(Number), s.src); }
  assert.equal(wide[0].src, 'screenshots/desktop.png'); assert.equal(other[0].src, 'screenshots/mobile.png');
});

// Decodes the unfiltered PNGs from scripts/generate-icons.mjs; the logo must stay inside the maskable safe zone (circle of radius 40% of the icon).
test('maskable icons are opaque and keep all logo pixels inside the safe-zone circle', async () => {
  const { inflateSync } = await import('node:zlib');
  for (const size of [192, 512]) {
    const b = readFileSync(join(dist, `icons/icon-maskable-${size}.png`));
    let off = 8; const idat = [];
    while (off < b.length) { const len = b.readUInt32BE(off); if (b.toString('ascii', off + 4, off + 8) === 'IDAT') idat.push(b.subarray(off + 8, off + 8 + len)); off += 12 + len; }
    const raw = inflateSync(Buffer.concat(idat)), stride = size * 4 + 1, bg = [0x17, 0x25, 0x54];
    let maxR = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * stride + 1 + x * 4;
      assert.equal(raw[i + 3], 255);
      if (raw[i] !== bg[0] || raw[i + 1] !== bg[1] || raw[i + 2] !== bg[2]) maxR = Math.max(maxR, Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2));
    }
    assert.ok(maxR <= size * 0.4, `${size}: logo reaches ${(maxR / size).toFixed(3)}`);
    console.log(`maskable-${size}: farthest logo pixel at ${(maxR / size * 100).toFixed(1)}% of icon size (limit 40%)`);
  }
});
