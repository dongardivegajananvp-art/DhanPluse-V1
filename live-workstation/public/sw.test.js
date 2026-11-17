import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('./sw.js', import.meta.url), 'utf8');
const origin = 'https://gv2vpd.test';

function createHarness(fetchImpl) {
  const handlers = {};
  const stores = new Map();
  const keyOf = value => {
    const raw = typeof value === 'string' ? value : value.url;
    return new URL(raw, origin).pathname;
  };
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async match(value) {
          const response = store.get(keyOf(value));
          return response ? response.clone() : undefined;
        },
        async put(value, response) {
          store.set(keyOf(value), response.clone());
        }
      };
    },
    async match(value) {
      for (const store of stores.values()) {
        const response = store.get(keyOf(value));
        if (response) return response.clone();
      }
      return undefined;
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); }
  };
  const self = {
    location: { origin },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
    addEventListener(type, callback) { handlers[type] = callback; }
  };
  vm.runInNewContext(source, { self, caches, fetch: fetchImpl, URL, Response, console });
  return { handlers, caches, stores };
}

function makeEvent(request) {
  return {
    request,
    background: [],
    response: null,
    respondWith(promise) { this.response = promise; },
    waitUntil(promise) { this.background.push(promise); }
  };
}

test('returns the cached GV2VPD page immediately when Render is still showing its cold-start page', async () => {
  const harness = createHarness(async () => new Response('Render loading page', {
    status: 503, headers: { 'content-type': 'text/html' }
  }));
  const cache = await harness.caches.open('gv2vpd-pwa-shell-v8');
  await cache.put('/', new Response('<title>GV2VPD | Live Trading Workstation</title><div id="feedState"></div>', {
    headers: { 'content-type': 'text/html' }
  }));

  const event = makeEvent({ method: 'GET', mode: 'navigate', url: origin + '/' });
  harness.handlers.fetch(event);
  const response = await event.response;
  assert.match(await response.text(), /GV2VPD \| Live Trading Workstation/);
  await Promise.all(event.background);
});

test('does not replace a cached JavaScript bundle with an HTML Render loading response', async () => {
  const harness = createHarness(async () => new Response('<html>Render loading page</html>', {
    status: 200, headers: { 'content-type': 'text/html' }
  }));
  const cache = await harness.caches.open('gv2vpd-pwa-shell-v8');
  await cache.put('/app.js', new Response('window.GV2VPD = true;', {
    headers: { 'content-type': 'application/javascript' }
  }));

  const event = makeEvent({ method: 'GET', mode: 'cors', url: origin + '/app.js' });
  harness.handlers.fetch(event);
  const response = await event.response;
  assert.equal(await response.text(), 'window.GV2VPD = true;');
  await Promise.all(event.background);
});

test('migrates the previous PWA shell cache before deleting it', async () => {
  const harness = createHarness(async () => new Response('unused'));
  const previous = await harness.caches.open('gv2vpd-pwa-shell-v7');
  await previous.put('/', new Response('<title>GV2VPD | Live Trading Workstation</title>', {
    headers: { 'content-type': 'text/html' }
  }));
  await previous.put('/app.js', new Response('cached app', {
    headers: { 'content-type': 'application/javascript' }
  }));

  const event = { waitUntil(promise) { this.pending = promise; } };
  harness.handlers.activate(event);
  await event.pending;
  assert.ok(await (await harness.caches.open('gv2vpd-pwa-shell-v8')).match('/'));
  assert.ok(await (await harness.caches.open('gv2vpd-pwa-shell-v8')).match('/app.js'));
  assert.deepEqual(await harness.caches.keys(), ['gv2vpd-pwa-shell-v8']);
});
