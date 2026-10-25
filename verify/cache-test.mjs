import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

const sources = ['index', 'snippet'];
let passed = 0;
const check = (name, condition) => { assert.ok(condition, name); passed++; };
const shared = new Map();

function harness(entry, storage = new Map()) {
  let now = 1700000000000;
  let calls = 0;
  let backend = async () => new Response(`version-${calls}`, {
    headers: { 'content-type': 'text/plain', 'cache-control': 'public, max-age=120' },
  });
  let broken = '';
  const tasks = [];
  class Clock extends Date { static now() { return now; } }
  const cache = {
    async match(key) {
      if (broken === 'match') throw new Error('Cache unavailable');
      const data = storage.get(key.url);
      return data ? new Response(data.body.slice(), { headers: data.headers }) : undefined;
    },
    async put(key, response) {
      const body = new Uint8Array(await response.arrayBuffer());
      if (broken === 'put') throw new Error('Cache unavailable');
      storage.set(key.url, { body, headers: [...response.headers] });
    },
    async delete(key) { return storage.delete(key.url); },
  };
  let sw;
  const context = vm.createContext({
    Date: Clock, URL, Request, Response, Headers, TransformStream, TextEncoder,
    crypto: webcrypto,
    caches: { async open(name) {
      if (broken === 'open') throw new Error('Cache unavailable');
      // Namespace separation is part of the real API, even when two entries share storage.
      return {
        match: key => cache.match({ url: name + ':' + key.url }),
        put: (key, response) => cache.put({ url: name + ':' + key.url }, response),
        delete: key => cache.delete({ url: name + ':' + key.url }),
      };
    } },
    fetch: async (...args) => { calls++; return backend(...args); },
    addEventListener: (event, handler) => { if (event === 'fetch') sw = handler; },
  });
  const source = fs.readFileSync(`src/${entry}.js`, 'utf8');
  vm.runInContext(source.replace('export default {', 'globalThis.moduleEntry = {'), context);
  const execution = { waitUntil(promise) { tasks.push(promise); } };
  async function flush() {
    while (tasks.length) await Promise.all(tasks.splice(0));
  }
  async function get(url = 'https://gh.example.test/o/r', headers = {}, options = {}) {
    const request = new Request(url, { method: options.method || 'GET', headers: { 'CF-IPCountry': 'CN', ...headers } });
    let response;
    if (sw) sw({ request, ...execution, respondWith(promise) { response = promise; } });
    else response = context.moduleEntry.fetch(request, {}, execution);
    const res = await response;
    const text = await res.text();
    if (options.drain !== false) await flush();
    return { res, text, state: res.headers.get('x-proxy-cache') };
  }
  return {
    get, flush, storage,
    get calls() { return calls; },
    at(seconds) { now = 1700000000000 + seconds * 1000; },
    set backend(fn) { backend = fn; },
    breakCache(mode) { broken = mode; },
  };
}

for (const entry of sources) {
  const h = harness(entry);
  check(`${entry}: cold miss`, (await h.get()).state === 'MISS' && h.calls === 1);
  h.at(29.999);
  const fresh = await h.get();
  check(`${entry}: 29.999s hit without origin`, fresh.state === 'HIT' && h.calls === 1);
  check(`${entry}: browser must revalidate`, fresh.res.headers.get('cache-control').includes('no-cache'));
  check(`${entry}: metadata stays private`, ![...fresh.res.headers].some(([key]) => key.startsWith('x-gh-proxy-internal-')));
  h.at(30);
  check(`${entry}: exactly 30s refreshes`, (await h.get()).state === 'STALE' && h.calls === 2);
  check(`${entry}: refreshed body is returned`, (await h.get()).text === 'version-2');

  const failed = harness(entry);
  await failed.get();
  failed.backend = async () => new Response('failure', { status: 503 });
  failed.at(30);
  check(`${entry}: background failure serves existing body`, (await failed.get()).text === 'version-1');
  failed.at(59.999);
  check(`${entry}: existing body inside hard boundary`, (await failed.get()).text === 'version-1');
  failed.at(60);
  const expired = await failed.get();
  check(`${entry}: exactly 60s cannot serve stale`, expired.res.status === 503 && expired.text === 'failure');

  const merged = harness(entry);
  await merged.get();
  merged.at(31);
  let release;
  merged.backend = () => new Promise(resolve => { release = () => resolve(new Response('new', { headers: { 'content-type': 'text/plain', 'cache-control': 'public, max-age=120' } })); });
  await merged.get(undefined, {}, { drain: false });
  await merged.get(undefined, {}, { drain: false });
  check(`${entry}: concurrent stale requests share one update`, merged.calls === 2);
  release();
  await merged.flush();

  for (const headers of [
    { cookie: 'session=TEST_ONLY' }, { authorization: 'Bearer TEST_ONLY' }, { range: 'bytes=0-1' },
    { 'cache-control': 'no-cache' }, { 'cache-control': 'no-store' }, { 'cache-control': 'max-age="0"' },
    { pragma: 'no-cache' }, { 'cf-access-jwt-assertion': 'TEST_ONLY' },
  ]) {
    const bypass = harness(entry);
    check(`${entry}: bypass ${Object.keys(headers)[0]}`, (await bypass.get(undefined, headers)).state === 'BYPASS' && bypass.storage.size === 0);
  }
  check(`${entry}: signed query bypass`, (await harness(entry).get('https://gh.example.test/o/r?access_token=TEST_ONLY')).state === 'BYPASS');
  check(`${entry}: short signature parameter bypass`, (await harness(entry).get('https://gh.example.test/o/r?sig=TEST_ONLY')).state === 'BYPASS');

  for (const [header, value] of [
    ['cache-control', 'private, max-age=120'], ['cache-control', 'no-store'], ['cache-control', 'no-cache'],
    ['cache-control', 'max-age=0'], ['cache-control', 'public'], ['cache-control', 'max-age=60, max-age=120'],
    ['set-cookie', 'session=TEST_ONLY'], ['vary', '*'], ['vary', 'CF-IPCountry'],
  ]) {
    const h = harness(entry);
    h.backend = async () => new Response('private', { headers: { 'content-type': 'text/plain', 'cache-control': 'public, max-age=120', [header]: value } });
    check(`${entry}: origin restriction ${header}=${value}`, (await h.get()).state === 'BYPASS' && h.storage.size === 0);
  }
  for (const status of [206, 302, 403, 404, 429, 500]) {
    const h = harness(entry);
    h.backend = async () => new Response('error', { status, headers: { 'cache-control': 'public, max-age=120' } });
    await h.get(); await h.get();
    check(`${entry}: status ${status} not cached`, h.calls === 2 && h.storage.size === 0);
  }

  const short = harness(entry);
  short.backend = async () => new Response('short', { headers: { 'cache-control': 'public, max-age=10' } });
  await short.get(); short.at(9);
  check(`${entry}: shorter origin TTL honored`, (await short.get()).state === 'HIT');
  short.at(10);
  check(`${entry}: shorter TTL expires`, (await short.get()).state === 'MISS');

  const aged = harness(entry);
  aged.backend = async () => new Response('aged', { headers: { 'cache-control': 'public, max-age=120', age: '110' } });
  await aged.get(); aged.at(10);
  check(`${entry}: upstream Age reduces freshness`, (await aged.get()).state === 'MISS');

  const dateAged = harness(entry);
  dateAged.backend = async () => new Response('dated', { headers: { 'cache-control': 'public, max-age=120', date: new Date(1700000000000 - 110000).toUTCString() } });
  await dateAged.get(); dateAged.at(10);
  check(`${entry}: old Date reduces freshness`, (await dateAged.get()).state === 'BYPASS');

  const expiredHeader = harness(entry);
  expiredHeader.backend = async () => new Response('expires', { headers: {
    date: new Date(1700000000000).toUTCString(), expires: new Date(1700000010000).toUTCString(),
  } });
  await expiredHeader.get(); expiredHeader.at(10);
  check(`${entry}: Expires deadline is honored`, (await expiredHeader.get()).state === 'BYPASS');

  const privatePage = harness(entry);
  privatePage.backend = async () => new Response('<html>private</html>', { headers: {
    'content-type': 'text/html', 'cache-control': 'private, no-store',
  } });
  const privateResult = await privatePage.get();
  check(`${entry}: browser retains private/no-store protection`, privateResult.res.headers.get('cache-control').includes('private') && privateResult.res.headers.get('cache-control').includes('no-store'));

  const long = harness(entry);
  long.backend = async () => new Response('asset', { headers: { 'content-type': 'application/javascript', 'cache-control': 'public, max-age=86400, immutable' } });
  const assetUrl = 'https://github-githubassets-com-gh.example.test/assets/app-0123456789abcdef.js';
  await long.get(assetUrl); long.at(120);
  check(`${entry}: fingerprinted immutable asset stays cached`, (await long.get(assetUrl)).state === 'HIT' && long.calls === 1);
  check(`${entry}: immutable assets preserve browser TTL`, !(await long.get(assetUrl)).res.headers.get('cache-control').includes('no-cache'));
  const mutable = harness(entry);
  mutable.backend = async () => new Response('asset', { headers: { 'content-type': 'application/javascript', 'cache-control': 'public, max-age=86400, immutable' } });
  await mutable.get('https://gh.example.test/app.js'); mutable.at(60);
  check(`${entry}: unversioned immutable claim still capped`, (await mutable.get('https://gh.example.test/app.js')).state === 'MISS');

  for (const broken of ['open', 'match', 'put']) {
    const h = harness(entry); h.breakCache(broken);
    check(`${entry}: cache ${broken} failure does not break proxy`, (await h.get()).res.status === 200);
  }
  const variants = harness(entry);
  variants.backend = async (url, init) => new Response(init.headers.get('accept') + ' ' + init.headers.get('x-requested-with'), {
    headers: { 'content-type': 'text/plain', 'cache-control': 'public, max-age=120', vary: 'Accept, X-Requested-With' },
  });
  await variants.get(undefined, { accept: 'text/html' });
  await variants.get(undefined, { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' });
  check(`${entry}: document and fragment are isolated`, (await variants.get(undefined, { accept: 'text/html' })).text === 'text/html null' && variants.calls === 2);
  await variants.get('https://gh.other.test/o/r', { accept: 'text/html' });
  await variants.get('https://gh.example.test/o/r?page=2', { accept: 'text/html' });
  check(`${entry}: host and complete query are isolated`, variants.calls === 4);
  const geo = await variants.get(undefined, { 'CF-IPCountry': 'US' });
  check(`${entry}: geo redirect runs before cache`, geo.res.status === 302 && variants.calls === 4);

  const head = harness(entry);
  const headed = await head.get(undefined, {}, { method: 'HEAD' });
  check(`${entry}: HEAD has no body and is not cached`, headed.text === '' && headed.state === 'BYPASS' && head.storage.size === 0);

  const privatized = harness(entry);
  await privatized.get(); privatized.at(30);
  privatized.backend = async () => new Response('private-now', { headers: { 'cache-control': 'private, no-store' } });
  await privatized.get();
  check(`${entry}: newly private origin evicts existing entry`, privatized.storage.size === 0);
  const oversized = harness(entry);
  oversized.backend = async () => new Response('x'.repeat(8 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=120' } });
  check(`${entry}: unknown-length oversized body still reaches client`, (await oversized.get()).text.length === 8 * 1024 * 1024 + 1 && oversized.storage.size === 0);
}

const index = harness('index', shared);
const snippet = harness('snippet', shared);
await index.get(); await snippet.get();
check('entry namespaces are isolated', index.calls === 1 && snippet.calls === 1 && shared.size === 2);
console.log(`CACHE RESULT pass=${passed} fail=0 (offline, fake clock, no external requests)`);
