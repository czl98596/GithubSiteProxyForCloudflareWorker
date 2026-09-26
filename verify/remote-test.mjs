/** 线上端到端检验：请求已部署的 Worker，验证映射、内容改写、重定向与边界行为。
 *
 *  用法：PROXY_DOMAIN=<你的域名> node verify/remote-test.mjs
 *  未设置 PROXY_DOMAIN 时用 example.com 占位，仅能检查脚本本身，无法真正连通。 */
const BASE = process.env.PROXY_DOMAIN || 'example.com';
const GH = 'gh.' + BASE; // README 约定入口（github.com 主站）
const GH_LEGACY = 'github-com-gh.' + BASE; // 兼容入口
const G_HOST = 'g.' + BASE; // 下载代理入口（gh-proxy）

// 供动态构造正则使用（仓库里不硬编码任何真实域名）
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const GH_RE = escapeRe(GH);
const G_HOST_RE = escapeRe(G_HOST);

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

async function req(url, opts = {}, tries = 3) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
        headers: {
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        },
        ...opts,
      });
    } catch (e) {
      // 本机到 Cloudflare 边缘偶发连接超时，重试区分网络抖动与真实故障
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

/** 边缘到 github.com 偶发连接超时（522），重试以区分"偶发"与"真实故障"。 */
async function reqRetry(url, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await req(url);
    if (last.status === 200) return last;
    await last.text();
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}

// 1. gh.<域名> 首页（README 约定入口）
{
  const res = await reqRetry('https://' + GH + '/');
  const text = await res.text();
  console.log('CASE1 status=' + res.status + ' type=' + res.headers.get('content-type') + ' bytes=' + text.length);
  const proxied = (text.match(new RegExp(GH_RE, 'g')) || []).length;
  const raw = (text.match(/https:\/\/github\.com(?=[/"'\s])/g) || []).length;
  console.log('CASE1 proxied_refs=' + proxied + ' raw_github_refs=' + raw);
  check('1a gh. 入口首页 200', res.status === 200, String(res.status));
  check('1b 首页为 HTML', (res.headers.get('content-type') || '').includes('text/html'), String(res.headers.get('content-type')));
  check('1c 链接已改写为 gh.<域名>', proxied > 0, 'proxied=' + proxied);
  check('1d 无残留原始 github.com 链接', raw === 0, 'raw=' + raw);
  check('1e 未残留 content-length', res.headers.get('content-length') === null, String(res.headers.get('content-length')));
  check('1f CORS 头已注入', res.headers.get('access-control-allow-origin') === '*', String(res.headers.get('access-control-allow-origin')));
  check('1g 返回的是 GitHub 首页', text.includes('<title>GitHub'), (text.match(/<title>([^<]*)<\/title>/i) || [])[1]);
}

// 2. gh.<域名> 仓库页面
{
  const res = await req('https://' + GH + '/octocat/Hello-World');
  const text = await res.text();
  const title = (text.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  console.log('CASE2 status=' + res.status + ' title=' + title);
  check('2a 仓库页 200', res.status === 200, String(res.status));
  check('2b 仓库页含 gh.<域名> 引用', text.includes(GH), 'len=' + text.length);
  check('2c 仓库标题正确', title.includes('octocat/Hello-World'), title);
}

// 3. 上游 302 -> Location 改写为 gh.<域名>
{
  const res = await req('https://' + GH + '/octocat/Hello-World/releases/latest');
  const loc = res.headers.get('location') || '';
  console.log('CASE3 status=' + res.status + ' location=' + loc);
  check('3a 上游重定向被透传', [301, 302, 303, 307, 308].includes(res.status), String(res.status));
  check('3b location 改写为 gh.<域名>（非 github.com）', loc === 'https://' + GH + '/octocat/Hello-World/releases', loc);
}

// 4. 上游 302 -> Location 改写为 *-gh.<域名>（跨子域重定向）
{
  const res = await req('https://' + GH + '/octocat/Hello-World/raw/master/README');
  const loc = res.headers.get('location') || '';
  console.log('CASE4 status=' + res.status + ' location=' + loc);
  check('4a raw 重定向被透传', [301, 302, 303, 307, 308].includes(res.status), String(res.status));
  check('4b location 改写为 raw-...-gh.<域名>', loc === 'https://raw-githubusercontent-com-gh.' + BASE + '/octocat/Hello-World/master/README', loc);
}

// 5. raw 子域直连
{
  const res = await req('https://raw-githubusercontent-com-gh.' + BASE + '/octocat/Hello-World/master/README');
  const text = await res.text();
  console.log('CASE5 status=' + res.status + ' body=' + JSON.stringify(text));
  check('5a raw 子域 200', res.status === 200, String(res.status));
  check('5b 内容为 README 正文', text.includes('Hello World'), JSON.stringify(text.slice(0, 60)));
}

// 6. api 子域
{
  const res = await req('https://api-github-com-gh.' + BASE + '/repos/octocat/Hello-World');
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {}
  console.log('CASE6 status=' + res.status + ' full_name=' + (json && json.full_name));
  check('6a api 子域可达（200，或 403 GitHub 匿名限流）', res.status === 200 || res.status === 403, String(res.status));
  // 注意：限流响应同样是合法 JSON，因此必须先按状态码分支，不能只看 JSON.parse 是否成功
  if (res.status === 200) {
    check('6b 200 时字段正确', !!json && json.full_name === 'octocat/Hello-World', text.slice(0, 120));
  } else {
    check('6b 403 时为 GitHub 限流提示', /rate limit/i.test(text), text.slice(0, 120));
  }
}

// 7. avatars 子域（二进制透传）
{
  const res = await req('https://avatars-githubusercontent-com-gh.' + BASE + '/u/583231');
  const buf = new Uint8Array(await res.arrayBuffer());
  const type = res.headers.get('content-type') || '';
  console.log('CASE7 status=' + res.status + ' type=' + type + ' bytes=' + buf.length);
  check('7a avatars 子域 200', res.status === 200, String(res.status));
  check('7b 返回图片二进制', type.startsWith('image/') && buf.length > 500, type + ' ' + buf.length);
}

// 8. jsdelivr 映射
{
  const res = await req('https://cdn-jsdelivr-net-gh.' + BASE + '/npm/jquery@3.7.1/dist/jquery.min.js');
  const text = await res.text();
  console.log('CASE8 status=' + res.status + ' bytes=' + text.length);
  check('8a jsdelivr 映射 200', res.status === 200, String(res.status));
  check('8b JS 内容非空', text.length > 1000, String(text.length));
}

// 9. 未知 -gh 前缀 -> Target lookup failed
{
  const res = await req('https://unknown-thing-gh.' + BASE + '/foo');
  const text = await res.text();
  check('9a 未知映射 404', res.status === 404, String(res.status));
  check('9b 404 提示 Target lookup failed', text.includes('Target lookup failed'), text.slice(0, 120));
}

// 10. 非代理子域（无路由）-> 不进入 Worker
{
  const res = await req('https://plain-sub.' + BASE + '/');
  const text = await res.text();
  console.log('CASE10 status=' + res.status + ' cors=' + res.headers.get('access-control-allow-origin'));
  check('10a 未进入 Worker（无 CORS 头）', res.headers.get('access-control-allow-origin') === null, String(res.headers.get('access-control-allow-origin')));
  check('10b 响应体不含代理改写痕迹', !new RegExp(GH_RE).test(text), 'len=' + text.length);
}

// 11. HTTP -> HTTPS 强制升级
{
  const res = await req('http://' + GH + '/octocat/Hello-World');
  const loc = res.headers.get('location') || '';
  console.log('CASE11 status=' + res.status + ' location=' + loc);
  check('11a http 被重定向到 https', [301, 302, 307, 308].includes(res.status) && loc.startsWith('https://'), res.status + ' ' + loc);
}

// 12. 嵌套路径修复（latest-commit）
{
  const res = await req('https://' + GH + '/octocat/Hello-World/latest-commit/master/https%3A//' + GH + '/octocat/Hello-World/commit/abc');
  console.log('CASE12 status=' + res.status);
  check('12a 嵌套路径未导致 5xx', res.status < 500, String(res.status));
}

// 13. 兼容性：旧的 github-com-gh.<域名> 入口仍可用
{
  const res = await req('https://' + GH_LEGACY + '/octocat/Hello-World');
  const text = await res.text();
  const rewritten = (text.match(new RegExp(GH_RE, 'g')) || []).length;
  console.log('CASE13 status=' + res.status + ' rewritten=' + rewritten);
  check('13a 旧入口仍 200', res.status === 200, String(res.status));
  check('13b 旧入口输出统一为 gh.<域名>', rewritten > 0, String(rewritten));
}

// 14. 压缩包下载代理（codeload.github.com）
{
  const res = await req('https://' + GH + '/octocat/Hello-World/archive/master.zip');
  const loc = res.headers.get('location') || '';
  console.log('CASE14 status=' + res.status + ' location=' + loc);
  check('14a 压缩包重定向改写为 codeload-...-gh.<域名>', loc === 'https://codeload-github-com-gh.' + BASE + '/octocat/Hello-World/zip/refs/heads/master', loc);
  if (loc) {
    const dl = await req(loc);
    const buf = new Uint8Array(await dl.arrayBuffer());
    console.log('CASE14 download status=' + dl.status + ' type=' + dl.headers.get('content-type') + ' bytes=' + buf.length);
    check('14b 经代理下载到真实 zip（PK 头）', dl.status === 200 && buf.length > 300 && buf[0] === 0x50 && buf[1] === 0x4b, dl.status + ' ' + buf.length + ' magic=' + buf[0] + ',' + buf[1]);
  }
}

// 15. release 页面里的下载链接应改写为 g.<域名>/https://github.com/...
let dlSample = null;
{
  const res = await req('https://' + GH + '/clash-verge-rev/clash-verge-rev/releases/tag/v2.5.6');
  const text = await res.text();
  const gLinks = [...new Set(text.match(new RegExp('https://' + G_HOST_RE + '/https://github\\.com/[^\\s"\'<>]*releases/download/[^\\s"\'<>]*', 'g')) || [])];
  const ghLinks = [...new Set(text.match(new RegExp('https://' + GH_RE + '/[^\\s"\'<>]*releases/download/[^\\s"\'<>]*', 'g')) || [])];
  console.log('CASE15 status=' + res.status + ' gLinks=' + gLinks.length + ' ghLinks=' + ghLinks.length);
  if (gLinks[0]) console.log('   sample=' + gLinks[0]);
  check('15a release 页面 200', res.status === 200, String(res.status));
  check('15b 页面内下载链接已是 g. 形式', gLinks.length > 0, String(gLinks.length));
  check('15c 页面内不再残留 gh. 形式下载链接', ghLinks.length === 0, String(ghLinks.length));
  dlSample = gLinks[0] || null;
}

// 16. 异步资产片段（下载按钮的真实来源）里的相对链接也必须改写
{
  const res = await req('https://' + GH + '/clash-verge-rev/clash-verge-rev/releases/expanded_assets/v2.5.6');
  const text = await res.text();
  const relLeft = (text.match(/href="\/clash-verge-rev\/clash-verge-rev\/releases\/download\//g) || []).length;
  const gLinks = [...new Set(text.match(new RegExp('href="https://' + G_HOST_RE + '/https://github\\.com/[^"]*releases/download/[^"]*"', 'g')) || [])];
  console.log('CASE16 status=' + res.status + ' remainingRelative=' + relLeft + ' rewritten=' + gLinks.length);
  check('16a 资产片段 200', res.status === 200, String(res.status));
  check('16b 相对下载链接已全部改写', relLeft === 0, String(relLeft));
  check('16c 已改写为 g. 形式', gLinks.length > 0, String(gLinks.length));
  if (!dlSample && gLinks[0]) dlSample = gLinks[0].slice(6, -1);
}

// 17. g. 形式链接可直连流式下载（gh-proxy 自动跟随上游 302，不暴露签名跳转）
if (dlSample) {
  const res = await req(dlSample, { headers: { Range: 'bytes=0-1023' } });
  const buf = new Uint8Array(await res.arrayBuffer());
  console.log('CASE17 status=' + res.status + ' bytes=' + buf.length + ' magic=' + buf[0] + ',' + buf[1]);
  check('17a g. 链接返回 200/206', res.status === 200 || res.status === 206, String(res.status));
  check('17b 内容为 PE 可执行文件（MZ 头）', buf[0] === 0x4d && buf[1] === 0x5a, buf[0] + ',' + buf[1]);
} else {
  check('17a 取得 g. 形式样本链接', false, 'no sample');
}

console.log('\nRESULT pass=' + pass + ' fail=' + fail);
process.exit(fail === 0 ? 0 : 1);
