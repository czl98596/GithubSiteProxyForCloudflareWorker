import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createGzip, gunzipSync } from 'node:zlib';
import http from 'node:http';
import { Readable } from 'node:stream';
import { Miniflare, Response, Log, LogLevel } from 'miniflare';

let passed = 0;
const check = (name, condition) => { assert.ok(condition, name); passed++; };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const encoder = new TextEncoder();
const results = [];
const prefix = '<html><head><title>ok</title></head><body><p>FIRST</p><script>const link="https://git';
const suffix = 'hub.com/o/r"; const data={"url":"https://raw.githubusercontent.com/o/r/main/a.txt"};</script>' +
  '<img src="//avatars.githubusercontent.com/u/1"><a href="/o/r/releases/download/v1/a.exe">download</a>' +
  '<img srcset="https://avatars.githubusercontent.com/u/1 1x, https://avatars.githubusercontent.com/u/2 2x">' +
  '<p>&lt;script&gt; https://github.com/o/r &amp;</p><!-- https://github.com/o/r --></body></html>';
const reportMode = process.argv.includes('--report');

async function instance(entry, source, outboundService) {
  // A real HTTP origin on loopback exercises workerd's native content decoding. Returning
  // encoded bodies through a JS service binding can have different automatic encoding rules.
  const origin = http.createServer(async (incoming, outgoing) => {
    try {
      const host = incoming.headers['x-audit-origin-host'];
      const response = await outboundService(new Request(`https://${host}${incoming.url}`, { headers: incoming.headers }));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) return outgoing.end();
      const stream = Readable.fromWeb(response.body);
      if (response.headers.get('content-encoding') === 'gzip') stream.pipe(createGzip()).pipe(outgoing);
      else stream.pipe(outgoing);
      stream.on('error', error => outgoing.destroy(error));
    } catch (error) { outgoing.writeHead(500); outgoing.end(String(error)); }
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  const port = origin.address().port;
  const routedSource = `const __localFetch = globalThis.fetch;\nglobalThis.fetch = (input, init) => {\n` +
    ` const original = new URL(input); const headers = new Headers(init.headers);\n` +
    ` headers.set('x-audit-origin-host', original.host); original.protocol = 'http:'; original.host = '127.0.0.1:${port}';\n` +
    ` return __localFetch(original.href, { ...init, headers });\n};\n` + source;
  const mf = new Miniflare({
    modules: entry === 'snippet', script: routedSource, compatibilityDate: '2024-04-06',
    host: '127.0.0.1', port: 0, upstream: 'https://gh.example.test', cf: false, cachePersist: false,
    outboundService: { network: { allow: ['127.0.0.1/32'] } }, log: new Log(LogLevel.ERROR),
  });
  const dispose = mf.dispose.bind(mf);
  mf.dispose = async () => { await dispose(); await new Promise(resolve => origin.close(resolve)); };
  try { await mf.ready; } catch (error) { await mf.dispose(); throw error; }
  return mf;
}

// Miniflare's Undici bridge replaces Host with its loopback address. Use real local HTTP
// with the original-url metadata so both unchanged baseline and new code see production Host.
async function dispatchLocal(mf, pathname, headers = {}) {
  const local = await mf.ready;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: local.hostname, port: local.port, path: pathname, method: 'GET',
      headers: { host: 'gh.example.test', 'MF-Original-URL': `https://gh.example.test${pathname}`, 'CF-IPCountry': 'CN', ...headers },
    }, incoming => {
      resolve(new Response(Readable.toWeb(incoming), { status: incoming.statusCode, headers: incoming.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

for (const entry of ['index', 'snippet']) {
  const source = fs.readFileSync(`src/${entry}.js`, 'utf8');
  let calls = 0;
  let release;
  let completed = false;
  const binary = new Uint8Array([0, 255, 128, 71, 72, 0, 1]);
  const outbound = async request => {
    const url = new URL(request.url);
    assert.ok(['github.com', 'github.githubassets.com'].includes(url.hostname), 'All origins are local mocks');
    calls++;
    if (url.pathname === '/stream') {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(prefix));
          release = () => { if (completed) return; controller.enqueue(encoder.encode(suffix)); controller.close(); completed = true; };
        },
      }), { headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/gzip-html') {
    // The local HTTP origin encodes this body once according to Content-Encoding.
      return new Response(prefix + suffix, {
        headers: { 'content-type': 'text/html', 'content-encoding': 'gzip', 'cache-control': 'no-store' },
      });
    }
    if (url.pathname === '/binary') {
      return new Response(binary, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/gzip-binary' || url.pathname === '/cache-gzip-binary') {
      return new Response(binary, {
        headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip',
          'cache-control': url.pathname === '/gzip-binary' ? 'no-store' : 'public, max-age=120' },
      });
    }
    if (url.pathname === '/utf8') {
      const bytes = encoder.encode('<html><body><p>中文 https://github.com/o/r</p></body></html>');
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(bytes.slice(0, 16));
        controller.enqueue(bytes.slice(16, 31));
        controller.enqueue(bytes.slice(31));
        controller.close();
      } }), { headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/long-text') {
      return new Response('<html><body>' + 'x'.repeat(70000) + ' https://github.com/o/r</body></html>',
        { headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/json') {
      return new Response('{"url":"https://github.com/o/r"}', {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    if (url.pathname === '/css') {
      return new Response('a{background:url("https://github.githubassets.com/a.png")}', {
        headers: { 'content-type': 'text/css', 'cache-control': 'no-store' },
      });
    }
    if (url.pathname === '/javascript') {
      return new Response('fetch("https://api.github.com/repos/o/r")', {
        headers: { 'content-type': 'application/javascript', 'cache-control': 'no-store' },
      });
    }
    return new Response(`page-${calls}`, {
      headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=120', vary: 'Accept, X-Requested-With' },
    });
  };
  const mf = await instance(entry, source, outbound);
  const fetch = (path, headers = {}) => dispatchLocal(mf, path, headers);
  try {
    const start = performance.now();
    // A release gate proves that no completed upstream body is needed for the first bytes.
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('HTML response buffered before headers')), 5000); });
    let response;
    try { response = await Promise.race([fetch('/stream'), timeout]); } finally { clearTimeout(timer); }
    if (response.status !== 200) throw new Error(`Unexpected streaming response: ${response.status} ${await response.text()}`);
    const reader = response.body.getReader();
    let readTimer;
    const first = await Promise.race([
      reader.read(),
      new Promise((_, reject) => { readTimer = setTimeout(() => reject(new Error('HTML first chunk was buffered')), 5000); }),
    ]).finally(() => clearTimeout(readTimer));
    check(`${entry}: first chunk precedes upstream completion`, !completed && first.value.byteLength > 0);
    const firstMs = performance.now() - start;
    release();
    let html = new TextDecoder().decode(first.value);
    while (true) { const chunk = await reader.read(); if (chunk.done) break; html += new TextDecoder().decode(chunk.value); }
    check(`${entry}: split inline JS URL rewritten`, html.includes('const link="https://gh.example.test/o/r"'));
    check(`${entry}: inline JSON download URL rewritten`, html.includes('https://g.example.test/https://raw.githubusercontent.com/o/r/main/a.txt'));
    check(`${entry}: protocol relative image rewritten`, html.includes('//avatars-githubusercontent-com-gh.example.test/u/1'));
    check(`${entry}: relative release asset rewritten`, html.includes('href="https://g.example.test/https://github.com/o/r/releases/download/v1/a.exe"'));
    check(`${entry}: srcset survives`, html.includes('avatars-githubusercontent-com-gh.example.test/u/2 2x'));
    check(`${entry}: escaped text stays escaped`, html.includes('&lt;script&gt;') && !html.includes('<p><script>'));
    check(`${entry}: comment URL rewritten`, html.includes('<!-- https://gh.example.test/o/r -->'));
    check(`${entry}: analytics behavior preserved`, html.includes('https://u.2x.nz/script.js') === (entry === 'snippet'));
    check(`${entry}: HTML never keeps upstream encoding`, response.headers.get('content-encoding') !== 'gzip');
    results.push({ entry, streamingFirstChunkMs: Number(firstMs.toFixed(2)), streamingCompleteMs: Number((performance.now() - start).toFixed(2)) });

    const zippedHtml = await (await fetch('/gzip-html')).text();
    check(`${entry}: compressed HTML decoded and rewritten`, zippedHtml.includes('https://gh.example.test/o/r') && zippedHtml.includes('<title>ok</title>'));
    const data = new Uint8Array(await (await fetch('/binary')).arrayBuffer());
    check(`${entry}: binary byte integrity`, Buffer.from(data).equals(Buffer.from(binary)));
    const compressed = Buffer.from(await (await fetch('/gzip-binary', { 'accept-encoding': 'gzip' })).arrayBuffer());
    const decoded = compressed[0] === 0x1f && compressed[1] === 0x8b ? gunzipSync(compressed) : compressed;
    check(`${entry}: compressed passthrough has no double encoding`, decoded.equals(Buffer.from(binary)));
    await (await fetch('/cache-gzip-binary', { 'accept-encoding': 'gzip' })).arrayBuffer();
    await sleep(60);
    const cachedBinary = await fetch('/cache-gzip-binary', { 'accept-encoding': 'gzip' });
    const cachedBytes = Buffer.from(await cachedBinary.arrayBuffer());
    const decodedCached = cachedBytes[0] === 0x1f && cachedBytes[1] === 0x8b ? gunzipSync(cachedBytes) : cachedBytes;
    check(`${entry}: cached compressed bytes retain integrity ${JSON.stringify({ state: cachedBinary.headers.get('x-proxy-cache'), encoding: cachedBinary.headers.get('content-encoding'), hex: cachedBytes.toString('hex'), decoded: decodedCached.toString('hex') })}`, cachedBinary.headers.get('x-proxy-cache') === 'HIT' && decodedCached.equals(Buffer.from(binary)));
    const unicode = await (await fetch('/utf8')).text();
    check(`${entry}: multibyte and URL chunk boundaries preserved`, unicode.includes('中文 https://gh.example.test/o/r'));
    const longText = await (await fetch('/long-text')).text();
    check(`${entry}: long text token is not lost`, longText.includes('x'.repeat(70000)) && longText.includes('https://gh.example.test/o/r'));
    check(`${entry}: JSON rewriting preserved`, (await (await fetch('/json')).text()).includes('https://gh.example.test/o/r'));
    check(`${entry}: CSS rewriting preserved`, (await (await fetch('/css')).text()).includes('https://github-githubassets-com-gh.example.test/a.png'));
    check(`${entry}: JavaScript rewriting preserved`, (await (await fetch('/javascript')).text()).includes('https://api-github-com-gh.example.test/repos/o/r'));

    const before = calls;
    const cold = await fetch('/cache', { accept: 'text/html' });
    const coldBody = await cold.text();
    await sleep(60); // Allow the real Cache API write registered with waitUntil to finish.
    const hot = await fetch('/cache', { accept: 'text/html' });
    check(`${entry}: actual Cache API hit`, hot.headers.get('x-proxy-cache') === 'HIT' && await hot.text() === coldBody && calls === before + 1);
    const fragment = await fetch('/cache', { accept: 'text/html', 'x-requested-with': 'XMLHttpRequest' });
    await fragment.text();
    check(`${entry}: actual Cache API fragment isolation`, fragment.headers.get('x-proxy-cache') === 'MISS' && calls === before + 2);
    const sensitive = await fetch('/cache', { cookie: 'TEST_ONLY=1', accept: 'text/html' });
    await sensitive.text();
    check(`${entry}: actual runtime credential bypass`, sensitive.headers.get('x-proxy-cache') === 'BYPASS');
  } finally {
    release?.();
    await mf.dispose();
  }

  // Same deterministic slow origin for baseline and updated source; all requests stay local.
  const baseline = fs.readFileSync(new URL(`./fixtures/baseline-${entry}.js`, import.meta.url), 'utf8');
  const measurements = [];
  for (const [label, script] of [['baseline', baseline], ['updated', source]]) {
    let originCalls = 0;
    const origin = async request => {
      if (new URL(request.url).pathname === '/warmup') return new Response('<html><head></head><body>ready</body></html>', {
        headers: { 'content-type': 'text/html', 'cache-control': 'no-store' },
      });
      originCalls++;
      return new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode('<html><head></head><body><p>visible</p>'));
          await sleep(180);
          controller.enqueue(encoder.encode('<a href="https://github.com/o/r">repo</a>'));
          await sleep(180);
          controller.enqueue(encoder.encode('</body></html>'));
          controller.close();
        },
      }), { headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } });
    };
    const runner = await instance(entry, script, origin);
    try {
      await (await dispatchLocal(runner, '/warmup')).text();
      const start = performance.now();
      const res = await dispatchLocal(runner, '/benchmark');
      const reader = res.body.getReader();
      await reader.read();
      const firstMs = performance.now() - start;
      while (!(await reader.read()).done) {}
      measurements.push({ label, firstChunkMs: Number(firstMs.toFixed(2)), completeMs: Number((performance.now() - start).toFixed(2)), originCalls });
    } finally { await runner.dispose(); }
  }
  check(`${entry}: delayed-origin first chunk improved ${JSON.stringify(measurements)}`, measurements[1].firstChunkMs < measurements[0].firstChunkMs / 2);
  results.push({ entry, controlledSlowOrigin: measurements });
}

console.log(`RUNTIME RESULT pass=${passed} fail=0 (workerd, outbound services mocked, no live endpoints)`);
console.log(JSON.stringify({ syntheticLocalMeasurements: results }, null, 2));
if (reportMode) fs.writeFileSync('verify/performance-final.txt', JSON.stringify(results, null, 2));
