/**
 * Vercel Serverless Proxy — api/index.js
 *
 * Route: everything hits this file.
 *   /?url=https://target.com      → proxy the target
 *   / (no ?url)                   → serve the landing UI inline
 *
 * Key fixes vs v1:
 *  - Single entry point avoids vercel.json routing/query-string bugs
 *  - Content-type sniffed from URL extension when upstream omits it
 *  - Correct MIME types always set on response (browser won't refuse JS/CSS)
 *  - Binary streaming fixed (no double-consume after redirect peek)
 *  - Redirect loop guard added
 *  - rewriteUrl never double-encodes already-proxied URLs
 *  - Script injection skipped for partial/non-200 responses
 */

'use strict';

const { URL }  = require('url');
const https    = require('https');
const http     = require('http');
const zlib     = require('zlib');
const path     = require('path');

// ─── MIME helpers ─────────────────────────────────────────────────────────────

const EXT_MIME = {
  '.html': 'text/html', '.htm': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript', '.mjs': 'application/javascript', '.cjs': 'application/javascript',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.xml':  'application/xml',
  '.txt':  'text/plain',
};

function sniffMime(urlObj, upstreamContentType) {
  if (upstreamContentType) return upstreamContentType.split(';')[0].trim().toLowerCase();
  const ext = path.extname(urlObj.pathname).toLowerCase();
  return EXT_MIME[ext] || 'application/octet-stream';
}

function isTextMime(mime) {
  return (
    mime.startsWith('text/') ||
    mime === 'application/javascript' ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'image/svg+xml'
  );
}

// ─── URL rewriting ────────────────────────────────────────────────────────────

function proxyBase(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host']  || req.headers.host;
  return `${proto}://${host}`;
}

function rewriteUrl(raw, base, pOrigin) {
  if (!raw) return raw;
  raw = raw.trim();
  if (/^(data:|javascript:|#|mailto:|tel:|blob:)/i.test(raw)) return raw;

  // Already proxied — don't double-encode
  if (
  raw.startsWith(pOrigin + '/proxy?url=') ||
  raw.startsWith('/proxy?url=')
) return raw;

  try {
    let abs;
    if (/^https?:\/\//i.test(raw))  abs = raw;
    else if (raw.startsWith('//'))  abs = 'https:' + raw;
    else                             abs = new URL(raw, base).href;
    return `${pOrigin}/proxy?url=${encodeURIComponent(abs)}`;
  } catch {
    return raw;
  }
}

// ─── HTML rewriting ───────────────────────────────────────────────────────────

function rewriteHtml(html, base, pOrigin) {
  const rw = u => rewriteUrl(u, base, pOrigin);

  // Standard URL attributes
  html = html.replace(
    /(\b(?:href|src|action|data-src|data-href|poster|content)\s*=\s*)(['"])(.*?)\2/gi,
    (full, attr, q, val) => {
      // Only rewrite content= on <meta http-equiv="refresh">
      if (/\bcontent\b/i.test(attr)) {
        if (!/url=/i.test(val)) return full;
        const rewritten = val.replace(/(url=)([^\s;'"]+)/i, (_, p, u) => p + rw(u));
        return `${attr}${q}${rewritten}${q}`;
      }
      return `${attr}${q}${rw(val)}${q}`;
    }
  );

  // srcset
  html = html.replace(
    /(\bsrcset\s*=\s*)(['"])(.*?)\2/gi,
    (_, attr, q, val) => {
      const rewritten = val.split(',').map(part => {
        const [u, ...rest] = part.trim().split(/\s+/);
        return u ? [rw(u), ...rest].join(' ') : part;
      }).join(', ');
      return `${attr}${q}${rewritten}${q}`;
    }
  );

  // Inline <style>
  html = html.replace(
    /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_, o, css, c) => `${o}${rewriteCss(css, base, pOrigin)}${c}`
  );

  // Inline <script> (no src attribute)
  html = html.replace(
    /(<script(?![^>]*\bsrc\b)[^>]*>)([\s\S]*?)(<\/script>)/gi,
    (_, o, js, c) => `${o}${rewriteJs(js, base, pOrigin)}${c}`
  );

  // Inject runtime before </head>
  const rt = buildRuntime(base, pOrigin);
  if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, `${rt}\n</head>`);
  } else if (/<body/i.test(html)) {
    html = html.replace(/<body/i, `${rt}\n<body`);
  } else {
    html = rt + '\n' + html;
  }

  return html;
}

function rewriteCss(css, base, pOrigin) {
  // url("…") / url('…') / url(…)
  return css.replace(
    /url\(\s*(['"]?)(.*?)\1\s*\)/gi,
    (_, q, u) => `url(${q}${rewriteUrl(u, base, pOrigin)}${q})`
  );
}

function rewriteJs(js, base, pOrigin) {
  const rw = u => rewriteUrl(u, base, pOrigin);

  // fetch("abs-url") — string literal only
  js = js.replace(
    /\bfetch\s*\(\s*(['"`])(https?:\/\/[^'"`\s]+)\1/g,
    (_, q, u) => `fetch(${q}${rw(u)}${q}`
  );

  // XMLHttpRequest .open(method, "abs-url")
  js = js.replace(
    /\.open\s*\(\s*(['"`][A-Z]+['"`])\s*,\s*(['"`])(https?:\/\/[^'"`\s]+)\2/gi,
    (_, m, q, u) => `.open(${m}, ${q}${rw(u)}${q}`
  );

  // location / window.location assignments
  js = js.replace(
    /\b((?:window\.)?location(?:\.href)?)\s*=\s*(['"`])(https?:\/\/[^'"`\s]+)\2/g,
    (_, prop, q, u) => `${prop} = ${q}${rw(u)}${q}`
  );

  // location.replace(…) / location.assign(…)
  js = js.replace(
    /\blocation\.(replace|assign)\s*\(\s*(['"`])(https?:\/\/[^'"`\s]+)\2/g,
    (_, fn, q, u) => `location.${fn}(${q}${rw(u)}${q}`
  );

  return js;
}

// ─── Runtime intercept script ─────────────────────────────────────────────────

function buildRuntime(base, pOrigin) {
  // Serialise once — these are injected verbatim into the page
  const B = JSON.stringify(base);
  const P = JSON.stringify(pOrigin);

  return `<script data-proxy="1">
(function(){
  var BASE=${B}, PROXY=${P};
  function rw(u){
    if(!u||/^(data:|javascript:|#|mailto:|tel:|blob:)/i.test(u))return u;
    if(u.indexOf(PROXY+'/?url=')===0||u.indexOf('/?url=')===0)return u;
    try{
      var a=/^https?:\\/\\//i.test(u)?u:u.startsWith('//')?'https:'+u:new URL(u,BASE).href;
      return PROXY+'/proxy?url='+encodeURIComponent(a);
    }catch(e){return u;}
  }

  /* history API */
  ['pushState','replaceState'].forEach(function(f){
    var o=history[f];
    history[f]=function(s,t,u){return o.call(this,s,t,u?rw(u):u);};
  });

  /* clicks */
  document.addEventListener('click',function(e){
    var a=e.target.closest('a[href]');
    if(!a)return;
    var h=a.getAttribute('href');
    if(!h||/^(#|javascript:|mailto:|tel:)/i.test(h))return;
    var r=rw(h);
    if(r!==h){e.preventDefault();e.stopPropagation();location.href=r;}
  },true);

  /* forms */
  document.addEventListener('submit',function(e){
    var f=e.target,a=f.getAttribute('action')||location.href;
    var r=rw(a);if(r!==a)f.setAttribute('action',r);
  },true);

  /* fetch */
  var _f=window.fetch;
  window.fetch=function(i,o){
    if(typeof i==='string')i=rw(i);
    else if(i&&i.url)i=new Request(rw(i.url),i);
    return _f.call(this,i,o);
  };

  /* XHR */
  var _o=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    var a=Array.from(arguments);a[1]=rw(u);return _o.apply(this,a);
  };

  /* dynamic src injection (e.g. script/img createElement) */
  var _sc=document.createElement.bind(document);
  document.createElement=function(tag){
    var el=_sc(tag);
    if(/^(script|img|iframe|link|source)$/i.test(tag)){
      var desc=Object.getOwnPropertyDescriptor(el.__proto__,'src')
             ||Object.getOwnPropertyDescriptor(el.__proto__,'href');
      if(desc&&desc.set){
        var prop=/^(link)$/i.test(tag)?'href':'src';
        var orig=desc;
        Object.defineProperty(el,prop,{
          set:function(v){orig.set.call(this,rw(v));},
          get:function(){return orig.get.call(this);}
        });
      }
    }
    return el;
  };
})();
</script>`;
}

// ─── Decompression ────────────────────────────────────────────────────────────

function decompress(res) {
  return new Promise((resolve, reject) => {
    const enc = (res.headers['content-encoding'] || '').toLowerCase();
    let stream = res;
    if      (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
    else if (enc === 'br')      stream = res.pipe(zlib.createBrotliDecompress());
    else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end',  () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// ─── Header filtering ─────────────────────────────────────────────────────────

const HOP_BY_HOP = new Set([
  'connection','keep-alive','proxy-authenticate','proxy-authorization',
  'te','trailers','transfer-encoding','upgrade','content-encoding',
]);
const STRIP_SECURITY = new Set([
  'x-frame-options','content-security-policy','content-security-policy-report-only',
  'strict-transport-security','x-content-type-options','x-xss-protection',
  'cross-origin-opener-policy','cross-origin-embedder-policy','cross-origin-resource-policy',
  'permissions-policy','report-to','nel',
]);

function buildRequestHeaders(incoming, targetHost) {
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    if (lk === 'host') continue;               // replaced below
    if (lk.startsWith('x-forwarded')) continue;
    if (lk === 'x-real-ip') continue;
    if (lk === 'x-vercel-id') continue;
    out[k] = v;
  }
  out['host']            = targetHost;
  out['accept-encoding'] = 'gzip, deflate, br';
  // Spoof a normal browser referer so sites don't block us
  out['referer']         = `https://${targetHost}/`;
  return out;
}

function buildResponseHeaders(incoming) {
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk))    continue;
    if (STRIP_SECURITY.has(lk)) continue;
    // Rewrite set-cookie Domain so cookies are sent back to us
    if (lk === 'set-cookie') continue; // handled separately
    out[k] = v;
  }
  out['access-control-allow-origin']  = '*';
  out['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, PATCH, OPTIONS';
  out['access-control-allow-headers'] = '*';
  return out;
}

// ─── Core fetch ───────────────────────────────────────────────────────────────

function fetchUpstream(options, body) {
  return new Promise((resolve, reject) => {
    const lib = options.protocol === 'https:' ? https : http;
    const req = lib.request(options, resolve);
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    return res.status(204).end();
  }

  const pBase = proxyBase(req);

  // ── No ?url → serve landing page ──────────────────────────────────────────
  const rawUrl = (req.query && req.query.url) || new URL(req.url, 'http://x').searchParams.get('url');
  if (!rawUrl) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(landingPage(pBase));
  }

  // ── Parse target ──────────────────────────────────────────────────────────
  let targetUrl;
  try {
    targetUrl = new URL(decodeURIComponent(rawUrl));
  } catch {
    return res.status(400).send('Bad Request: invalid URL');
  }
  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return res.status(400).send('Bad Request: only http/https');
  }

  // ── Read request body ─────────────────────────────────────────────────────
  let body = null;
  if (!['GET', 'HEAD'].includes(req.method)) {
    body = await new Promise(resolve => {
      const c = []; req.on('data', d => c.push(d)); req.on('end', () => resolve(Buffer.concat(c)));
    });
  }

  // ── Follow redirects (max 10) ─────────────────────────────────────────────
  let current = targetUrl;
  let upRes;
  for (let hops = 0; hops < 10; hops++) {
    const opts = {
      protocol: current.protocol,
      hostname: current.hostname,
      port:     current.port || (current.protocol === 'https:' ? 443 : 80),
      path:     current.pathname + current.search,
      method:   req.method,
      headers:  buildRequestHeaders(req.headers, current.host),
    };
    upRes = await fetchUpstream(opts, body).catch(err => {
      res.status(502).send(`Upstream error: ${err.message}`);
      return null;
    });
    if (!upRes) return;

    if ([301, 302, 303, 307, 308].includes(upRes.statusCode)) {
      const loc = upRes.headers['location'];
      if (loc) {
        // Drain so the socket is freed
        upRes.resume();
        try { current = new URL(loc, current.href); } catch { break; }
        if (hops === 9) {
          // Too many redirects — surface to client
          res.setHeader('Location', rewriteUrl(loc, current.href, pBase));
          return res.status(302).end();
        }
        continue;
      }
    }
    break; // non-redirect status
  }

  // ── Determine content type ────────────────────────────────────────────────
  const rawCt  = upRes.headers['content-type'] || '';
  const mime   = sniffMime(current, rawCt || '');
  const isHtml = mime === 'text/html';
  const isCss  = mime === 'text/css';
  const isJs   = mime === 'application/javascript' || mime === 'text/javascript';
  const isSvg  = mime === 'image/svg+xml';
  const doRewrite = isHtml || isCss || isJs || isSvg;

  // ── Set response headers ──────────────────────────────────────────────────
  const respHeaders = buildResponseHeaders(upRes.headers);

  // Always set an explicit, correct Content-Type (fixes browser MIME blocks)
  const charset = (isHtml || isCss || isJs || isSvg) ? '; charset=utf-8' : '';
  respHeaders['content-type'] = `${mime}${charset}`;

  for (const [k, v] of Object.entries(respHeaders)) res.setHeader(k, v);
  res.removeHeader('content-length'); // will change after rewrite

  // ── Stream binary / rewrite text ──────────────────────────────────────────
  if (!doRewrite) {
    res.status(upRes.statusCode);
    upRes.pipe(res);
    return;
  }

  let text;
  try {
    const buf = await decompress(upRes);
    text = buf.toString('utf8');
  } catch (err) {
    return res.status(502).send(`Decompression error: ${err.message}`);
  }

  if (isHtml) text = rewriteHtml(text, current.href, pBase);
  else if (isCss) text = rewriteCss(text, current.href, pBase);
  else if (isJs)  text = rewriteJs(text,  current.href, pBase);
  else if (isSvg) text = rewriteHtml(text, current.href, pBase); // SVG can have hrefs

  res.status(upRes.statusCode).send(text);
};

// ─── Inline landing page ──────────────────────────────────────────────────────

function landingPage(pBase) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Proxy Gateway</title>
<style>
:root{--bg:#0a0a0f;--surface:#13131a;--border:#1e1e2e;--accent:#6c63ff;--accent2:#a78bfa;--text:#e2e8f0;--muted:#64748b;--r:12px;--font:'DM Mono','Fira Code',monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--font);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(108,99,255,.04)1px,transparent 1px),linear-gradient(90deg,rgba(108,99,255,.04)1px,transparent 1px);background-size:40px 40px;pointer-events:none}
.card{background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:48px 40px;max-width:600px;width:100%;box-shadow:0 0 80px rgba(108,99,255,.12)}
.badge{display:inline-block;font-size:10px;letter-spacing:3px;text-transform:uppercase;color:var(--accent2);border:1px solid rgba(167,139,250,.25);border-radius:99px;padding:4px 12px;margin-bottom:20px}
h1{font-size:clamp(22px,4vw,30px);font-weight:600;margin-bottom:8px;letter-spacing:-.5px}
h1 span{background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
p.sub{font-size:13px;color:var(--muted);margin-bottom:32px;line-height:1.6}
.row{display:flex;gap:10px;margin-bottom:10px}
input{flex:1;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:12px 16px;border-radius:var(--r);font-family:var(--font);font-size:13px;outline:none;transition:border-color .2s}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(108,99,255,.15)}
input::placeholder{color:var(--muted)}
button{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border:none;padding:12px 22px;border-radius:var(--r);font-family:var(--font);font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;transition:opacity .2s,transform .1s}
button:hover{opacity:.9}button:active{transform:scale(.97)}
.err{font-size:12px;color:#f87171;margin-top:6px;min-height:18px}
.divider{height:1px;background:var(--border);margin:28px 0}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.feat{display:flex;align-items:flex-start;gap:10px}
.icon{width:28px;height:28px;border-radius:8px;background:rgba(108,99,255,.12);display:grid;place-items:center;font-size:13px;flex-shrink:0}
.fl{font-size:11px;font-weight:600}.fd{font-size:10px;color:var(--muted);margin-top:2px}
</style>
</head>
<body>
<div class="card">
  <div class="badge">◈ Proxy Gateway</div>
  <h1>Access your sites<br><span>anywhere, seamlessly.</span></h1>
  <p class="sub">Enter a URL to route it through the proxy with full HTML, CSS &amp; JS rewriting.</p>
  <div class="row">
    <input id="u" type="url" placeholder="https://example.com" autocomplete="off" spellcheck="false"/>
    <button onclick="go()">Go →</button>
  </div>
  <div class="err" id="e"></div>
  <div class="divider"></div>
  <div class="grid">
    <div class="feat"><div class="icon">⟳</div><div><div class="fl">Full Rewriting</div><div class="fd">HTML, CSS, JS &amp; redirects</div></div></div>
    <div class="feat"><div class="icon">⚡</div><div><div class="fl">Edge-Fast</div><div class="fd">Vercel serverless</div></div></div>
    <div class="feat"><div class="icon">🔒</div><div><div class="fl">Auth Passthrough</div><div class="fd">Cookies &amp; headers forwarded</div></div></div>
    <div class="feat"><div class="icon">◎</div><div><div class="fl">White-Label</div><div class="fd">Origin headers stripped</div></div></div>
  </div>
</div>
<script>
function go(){
  var v=document.getElementById('u').value.trim();
  var e=document.getElementById('e');
  if(!v){e.textContent='Please enter a URL.';return;}
  if(!/^https?:\\/\\//i.test(v))v='https://'+v;
  try{new URL(v);}catch{e.textContent='Invalid URL.';return;}
  e.textContent='';
  window.location.href='/?url='+encodeURIComponent(v);
}
document.getElementById('u').addEventListener('keydown',function(e){if(e.key==='Enter')go();});
</script>
</body>
</html>`;
}
