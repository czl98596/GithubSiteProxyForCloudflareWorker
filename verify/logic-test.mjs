/**
 * 纯 Node 端逻辑检验：不需要 esbuild / workerd，直接加载两个入口源码，
 * stub 全局 fetch 以观察出站请求，验证域名映射、内容替换、重定向与路径修复。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = process.cwd();
let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log('PASS  ' + name);
  } else {
    fail++;
    console.log('FAIL  ' + name + (extra ? '  << ' + extra : ''));
  }
}

async function loadHandlers() {
  // snippet.js 是 ESM（export default），复制为 .mjs 后动态 import
  const snippetSrc = fs.readFileSync(path.join(root, 'src/snippet.js'), 'utf8');
  const mjsPath = path.join(root, 'verify', 'snippet.mjs');
  fs.writeFileSync(mjsPath, snippetSrc);
  const mod = await import(pathToFileURL(mjsPath).href + '?t=' + Date.now());

  // index.js 是 Service Worker 风格（addEventListener），以 CJS 加载并捕获 handler
  let swHandler = null;
  const prevAdd = globalThis.addEventListener;
  globalThis.addEventListener = (type, fn) => {
    if (type === 'fetch') swHandler = fn;
  };
  const cjsPath = path.join(root, 'verify', 'index.cjs');
  fs.writeFileSync(cjsPath, fs.readFileSync(path.join(root, 'src/index.js'), 'utf8'));
  const require = createRequire(import.meta.url);
  require(cjsPath);
  globalThis.addEventListener = prevAdd;

  return [
    {
      label: 'src/index.js (service-worker)',
      call: async (req) => {
        let captured = null;
        swHandler({ request: req, respondWith: (p) => { captured = p; } });
        return captured;
      },
    },
    {
      label: 'src/snippet.js (module)',
      call: (req) => mod.default.fetch(req, {}, {}),
    },
  ];
}

async function runCase(handler, url, opts = {}) {
  const {
    country = '',
    status = 200,
    body = '',
    contentType = 'text/html',
    location = '',
  } = opts;

  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: typeof input === 'string' ? input : input.url, init });
    const headers = new Headers({ 'content-type': contentType });
    if (location) headers.set('location', location);
    if (status >= 300 && status < 400) return new Response(null, { status, headers });
    return new Response(body, { status, headers });
  };

  const headers = new Headers();
  if (country) headers.set('CF-IPCountry', country);

  try {
    const res = await handler.call(new Request(url, { headers }));
    const text = await res.text();
    return { res, text, calls };
  } finally {
    globalThis.fetch = origFetch;
  }
}

const HTML_BODY = [
  '<html><head><title>t</title></head><body>',
  '<a href="https://github.com/octocat/Hello-World">repo</a>',
  '<img src="//avatars.githubusercontent.com/u/583231">',
  '<script src="https://github.githubassets.com/assets/app.js"></script>',
  '</body></html>',
].join('');

const handlers = await loadHandlers();

for (const h of handlers) {
  console.log('\n=== ' + h.label + ' ===');

  // 1. github.com 主站映射 + 内容替换
  {
    const { res, text, calls } = await runCase(h, 'https://github-com-gh.example.com/octocat/Hello-World', {
      body: HTML_BODY,
      contentType: 'text/html',
    });
    check('1a upstream host -> github.com', calls[0] && calls[0].url.startsWith('https://github.com/'), JSON.stringify(calls));
    check('1b upstream path preserved', calls[0] && new URL(calls[0].url).pathname === '/octocat/Hello-World', calls[0] && calls[0].url);
    check('1c status 200', res.status === 200, String(res.status));
    check('1d github.com 链接改写为 gh.<后缀>', text.includes('https://gh.example.com/octocat/Hello-World'), text.slice(0, 200));
    check('1e rewrite protocol-relative avatars', text.includes('//avatars-githubusercontent-com-gh.example.com/u/583231'), text.slice(0, 300));
    check('1f rewrite githubassets', text.includes('https://github-githubassets-com-gh.example.com/assets/app.js'), text.slice(0, 300));
    check('1g content-length removed', !res.headers.get('content-length'), String(res.headers.get('content-length')));
    check('1h cors header set', res.headers.get('access-control-allow-origin') === '*', String(res.headers.get('access-control-allow-origin')));
  }

  // 2. 子域映射：raw.githubusercontent.com
  {
    const { calls } = await runCase(h, 'https://raw-githubusercontent-com-gh.example.com/user/repo/main/README.md', {
      body: 'hello',
      contentType: 'text/plain',
    });
    check('2a raw upstream mapping', calls[0] && calls[0].url === 'https://raw.githubusercontent.com/user/repo/main/README.md', JSON.stringify(calls));
  }

  // 3. 未配置域名 -> 404，且不发出上游请求
  {
    const { res, calls } = await runCase(h, 'https://example.com/foo', { body: 'x' });
    check('3a unconfigured host -> 404', res.status === 404, String(res.status));
    check('3b no upstream call', calls.length === 0, JSON.stringify(calls));
  }

  // 4. 上游 302 Location 改写
  {
    const { res } = await runCase(h, 'https://github-com-gh.example.com/octocat', {
      status: 302,
      location: 'https://github.com/octocat/Hello-World',
    });
    check('4a 302 passthrough', res.status === 302, String(res.status));
    check('4b location rewritten', res.headers.get('location') === 'https://gh.example.com/octocat/Hello-World', String(res.headers.get('location')));
  }

  // 5. 嵌套路径修复（latest-commit）
  {
    const { calls } = await runCase(
      h,
      'https://github-com-gh.example.com/octocat/Hello-World/latest-commit/main/https%3A//github-com-gh.example.com/octocat/Hello-World/commit/abc',
      { body: 'ok', contentType: 'text/plain' }
    );
    const p = calls[0] ? new URL(calls[0].url).pathname : '';
    check('5a nested latest-commit truncated', p === '/octocat/Hello-World/latest-commit/main', p);
  }

  // 6. 海外 IP 地理重定向
  {
    const { res, calls } = await runCase(h, 'https://github-com-gh.example.com/octocat/Hello-World', {
      country: 'US',
      body: 'x',
    });
    check('6a US -> 302', res.status === 302, String(res.status));
    check('6b US -> raw github.com', res.headers.get('location') === 'https://github.com/octocat/Hello-World', String(res.headers.get('location')));
    check('6c US -> no upstream call', calls.length === 0, JSON.stringify(calls));
  }

  // 7. CN 不重定向
  {
    const { res, calls } = await runCase(h, 'https://github-com-gh.example.com/octocat/Hello-World', {
      country: 'CN',
      body: '<html></html>',
    });
    check('7a CN -> proxied 200', res.status === 200, String(res.status));
    check('7b CN -> upstream github.com', calls.length === 1 && calls[0].url.startsWith('https://github.com/'), JSON.stringify(calls));
  }

  // 8. HTTP 强制升级 HTTPS
  {
    const { res } = await runCase(h, 'http://github-com-gh.example.com/octocat', { body: 'x' });
    check('8a http -> redirect', [301, 302, 307, 308].includes(res.status), String(res.status));
    check('8b http -> https location', (res.headers.get('location') || '').startsWith('https://'), String(res.headers.get('location')));
  }

  // 9. 非文本透传
  {
    const { res, text } = await runCase(h, 'https://github-com-gh.example.com/logo.png', {
      body: 'BINARY',
      contentType: 'image/png',
    });
    check('9a binary passthrough', res.status === 200 && text === 'BINARY', text);
  }

  // 10. snippet.js 统计脚本注入（仅 module 版有）
  if (h.label.includes('snippet')) {
    const { text } = await runCase(h, 'https://github-com-gh.example.com/', { body: '<html><head></head><body></body></html>' });
    check('10a analytics script injected', text.includes('u.2x.nz/script.js'), text.slice(0, 200));
  }

  // 11. gh. 前缀入口（README 约定）映射到 github.com
  {
    const { res, calls, text } = await runCase(h, 'https://gh.example.com/octocat/Hello-World', { body: HTML_BODY });
    check('11a gh. 前缀 -> github.com', calls[0] && calls[0].url === 'https://github.com/octocat/Hello-World', JSON.stringify(calls));
    check('11b gh. 入口 200', res.status === 200, String(res.status));
    check('11c gh. 入口链接自洽', text.includes('https://gh.example.com/octocat/Hello-World'), text.slice(0, 200));
    check('11d gh. 入口下子域仍用 -gh. 形式', text.includes('//avatars-githubusercontent-com-gh.example.com/u/583231'), text.slice(0, 300));
  }

  // 12. gh. 入口下的上游重定向改写
  {
    const { res } = await runCase(h, 'https://gh.example.com/octocat', {
      status: 302,
      location: 'https://github.com/octocat/Hello-World',
    });
    check('12a gh. 入口 location 改写', res.headers.get('location') === 'https://gh.example.com/octocat/Hello-World', String(res.headers.get('location')));
  }

  // 13. gh. 入口海外 IP 回源
  {
    const { res } = await runCase(h, 'https://gh.example.com/octocat', { country: 'US', body: 'x' });
    check('13a gh. 入口 US 回源 github.com', res.status === 302 && res.headers.get('location') === 'https://github.com/octocat', res.status + ' ' + res.headers.get('location'));
  }

  // 14. gh. 入口 HTTP 强制升级
  {
    const { res } = await runCase(h, 'http://gh.example.com/octocat', { body: 'x' });
    check('14a gh. 入口 http -> https', [301, 302, 307, 308].includes(res.status) && (res.headers.get('location') || '').startsWith('https://'), res.status + ' ' + res.headers.get('location'));
  }

  // 15. 兼容性：github-com-gh. 旧入口仍然可用
  {
    const { res, calls } = await runCase(h, 'https://github-com-gh.example.com/octocat/Hello-World', { body: 'ok', contentType: 'text/plain' });
    check('15a 旧 -gh. 入口仍映射 github.com', res.status === 200 && calls[0].url === 'https://github.com/octocat/Hello-World', String(res.status));
  }
}

console.log('\nRESULT pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
