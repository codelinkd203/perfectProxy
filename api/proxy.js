/**
 * Vercel Serverless Proxy — api/proxy.js
 * Handles: ?url=https://target.com/path
 * Rewrites all HTML, CSS, JS, and redirect headers so every
 * resource and navigation stays inside the proxy.
 */

const { URL } = require('url');
const https = require('https');
const http  = require('http');
const zlib  = require('zlib');

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build the proxy base URL from the incoming request */
function proxyBase(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

/** Encode a full URL for use as the ?url= query param */
function encodeTarget(url) {
  return encodeURIComponent(url);
}

/**
 * Rewrite a single URL string so it routes back through the proxy.
 * Handles absolute URLs, protocol-relative URLs, and relative paths.
 */
function rewriteUrl(raw, base, proxyOrigin) {
  if (!raw) return raw;
  raw = raw.trim();

  // Leave data URIs, javascript: and # fragments alone
  if (/^(data:|javascript:|#|mailto:|tel:)/i.test(raw)) return raw;

  try {
    let absolute;
    if (/^https?:\/\//i.test(raw)) {
      absolute = raw;
    } else if (raw.startsWith('//')) {
      absolute = 'https:' + raw;
    } else {
      absolute = new URL(raw, base).href;
    }
    return `${proxyOrigin}/?url=${encodeTarget(absolute)}`;
  } catch {
    return raw;
  }
}

/**
 * Rewrite all URLs inside an HTML document:
 *  - href / src / action / srcset / data-src / poster attributes
 *  - <meta http-equiv="refresh"> content
 *  - CSS url() inside <style> blocks
 *  - Inline JS fetch / location references (best-effort)
 *  - Inject a small runtime script that intercepts dynamic navigation
 */
function rewriteHtml(html, base, proxyOrigin) {
  // Helper used repeatedly in replacements
  const rw = (u) => rewriteUrl(u, base, proxyOrigin);

  // --- Attribute rewrites ---------------------------------------------------

  // href / src / action / data-src / poster
  html = html.replace(
    /(\b(?:href|src|action|data-src|data-href|poster)\s*=\s*)(['"])(.*?)\2/gi,
    (_, attr, q, val) => `${attr}${q}${rw(val)}${q}`
  );

  // srcset  (comma-separated "url [descriptor]" pairs)
  html = html.replace(
    /(\bsrcset\s*=\s*)(['"])(.*?)\2/gi,
    (_, attr, q, val) => {
      const rewritten = val.split(',').map(part => {
        const [u, ...rest] = part.trim().split(/\s+/);
        return [rw(u), ...rest].join(' ');
      }).join(', ');
      return `${attr}${q}${rewritten}${q}`;
    }
  );

  // <meta http-equiv="refresh" content="N; url=...">
  html = html.replace(
    /(<meta[^>]+http-equiv\s*=\s*['"]refresh['"][^>]+content\s*=\s*['"])([^'"]*?)(['"])/gi,
    (_, pre, content, post) => {
      const rewritten = content.replace(/(url=)(.+)/i, (__, prefix, u) => prefix + rw(u.trim()));
      return `${pre}${rewritten}${post}`;
    }
  );

  // <link rel="preload/prefetch" as="..."> — already caught by href above

  // --- Inline <style> blocks ------------------------------------------------
  html = html.replace(
    /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_, open, css, close) => `${open}${rewriteCss(css, base, proxyOrigin)}${close}`
  );

  // --- Inline <script> blocks (best-effort) ---------------------------------
  html = html.replace(
    /(<script(?:[^>](?!src))*>)([\s\S]*?)(<\/script>)/gi,
    (_, open, js, close) => `${open}${rewriteJs(js, base, proxyOrigin)}${close}`
  );

  // --- Inject runtime intercept script before </head> -----------------------
  const runtimeScript = buildRuntimeScript(base, proxyOrigin);
  if (/<\/head>/i.test(html)) {
    html = html.replace(/<\/head>/i, `${runtimeScript}\n</head>`);
  } else {
    // No <head>? Prepend.
    html = runtimeScript + '\n' + html;
  }

  return html;
}

/** Rewrite url() references inside CSS text */
function rewriteCss(css, base, proxyOrigin) {
  return css.replace(
    /url\(\s*(['"]?)(.*?)\1\s*\)/gi,
    (_, q, u) => `url(${q}${rewriteUrl(u, base, proxyOrigin)}${q})`
  );
}

/**
 * Best-effort JS rewriting:
 *  - fetch("…") / fetch('…')
 *  - XMLHttpRequest .open(method, "…")
 *  - import("…") dynamic imports
 *  - location.href = / location.replace( / location.assign(
 *  - window.location assignments
 * This won't catch every case (eval, computed strings, etc.) but covers
 * the vast majority of real-world usage.
 */
function rewriteJs(js, base, proxyOrigin) {
  const rw = (u) => rewriteUrl(u, base, proxyOrigin);

  // fetch("url") / fetch('url')
  js = js.replace(
    /\bfetch\s*\(\s*(['"`])(https?:\/\/[^'"`]+)\1/g,
    (_, q, u) => `fetch(${q}${rw(u)}${q}`
  );

  // XHR .open(method, "url")
  js = js.replace(
    /\.open\s*\(\s*(['"`][^'"`]*['"`])\s*,\s*(['"`])(https?:\/\/[^'"`]+)\2/g,
    (_, method, q, u) => `.open(${method}, ${q}${rw(u)}${q}`
  );

  // location assignments
  js = js.replace(
    /\b(location\.href|location\.replace|location\.assign|window\.location\.href)\s*([=(])\s*(['"`])(https?:\/\/[^'"`]+)\3/g,
    (_, prop, op, q, u) => `${prop}${op}${q}${rw(u)}${q}`
  );

  return js;
}

/**
 * A small script injected into every proxied HTML page.
 * It intercepts:
 *  - pushState / replaceState
 *  - anchor clicks
 *  - form submissions
 *  - fetch() calls at runtime
 */
function buildRuntimeScript(base, proxyOrigin) {
  return `<script data-proxy-runtime="1">
(function(){
  var _base = ${JSON.stringify(base)};
  var _proxy = ${JSON.stringify(proxyOrigin)};

  function toProxyUrl(u) {
    if (!u || /^(data:|javascript:|#|mailto:|tel:)/i.test(u)) return u;
    try {
      var abs = /^https?:\\/\\//i.test(u) ? u
              : u.startsWith('//') ? 'https:' + u
              : new URL(u, _base).href;
      return _proxy + '/?url=' + encodeURIComponent(abs);
    } catch(e) { return u; }
  }

  // Intercept pushState / replaceState
  ['pushState','replaceState'].forEach(function(fn){
    var orig = history[fn];
    history[fn] = function(state, title, url) {
      return orig.call(this, state, title, url ? toProxyUrl(url) : url);
    };
  });

  // Intercept anchor clicks
  document.addEventListener('click', function(e){
    var a = e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href)) return;
    var rw = toProxyUrl(href);
    if (rw !== href) { e.preventDefault(); location.href = rw; }
  }, true);

  // Intercept form submissions
  document.addEventListener('submit', function(e){
    var form = e.target;
    var action = form.getAttribute('action') || location.href;
    var rw = toProxyUrl(action);
    if (rw !== action) { form.setAttribute('action', rw); }
  }, true);

  // Intercept fetch()
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string') input = toProxyUrl(input);
    else if (input && input.url) input = new Request(toProxyUrl(input.url), input);
    return _fetch.call(this, input, init);
  };

  // Intercept XMLHttpRequest
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    arguments[1] = toProxyUrl(url);
    return _open.apply(this, arguments);
  };
})();
</script>`;
}

// ─── Response decompression ──────────────────────────────────────────────────

function decompress(res, callback) {
  const encoding = (res.headers['content-encoding'] || '').toLowerCase();
  let stream = res;
  if (encoding === 'gzip')    stream = res.pipe(zlib.createGunzip());
  else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
  else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());

  const chunks = [];
  stream.on('data', c => chunks.push(c));
  stream.on('end',  () => callback(null, Buffer.concat(chunks)));
  stream.on('error', callback);
}

// ─── Headers helpers ─────────────────────────────────────────────────────────

const HOP_BY_HOP = new Set([
  'connection','keep-alive','proxy-authenticate','proxy-authorization',
  'te','trailers','transfer-encoding','upgrade',
  'content-encoding', // we decode ourselves
]);

function filterRequestHeaders(headers, targetHost) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    if (lk === 'host') { out['host'] = targetHost; continue; }
    // Strip proxy-specific headers
    if (lk.startsWith('x-forwarded') || lk === 'x-real-ip') continue;
    out[k] = v;
  }
  out['accept-encoding'] = 'gzip, deflate, br'; // we handle decoding
  return out;
}

function filterResponseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    // Drop security headers that would lock the browser to the origin
    if (['x-frame-options','content-security-policy',
         'content-security-policy-report-only',
         'strict-transport-security','x-content-type-options',
         'x-xss-protection'].includes(lk)) continue;
    out[k] = v;
  }
  // Allow embedding from anywhere (white-label)
  out['access-control-allow-origin'] = '*';
  return out;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  const pBase = proxyBase(req);

  // Parse target URL
  const rawUrl = req.query.url;
  if (!rawUrl) {
    res.setHeader('Content-Type', 'text/html');
    res.status(400).send('<h1>400 — Missing ?url= parameter</h1>');
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(decodeURIComponent(rawUrl));
  } catch {
    res.status(400).send('Invalid URL');
    return;
  }

  // Only allow http(s)
  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    res.status(400).send('Only http/https allowed');
    return;
  }

  const lib = targetUrl.protocol === 'https:' ? https : http;
  const port = targetUrl.port
    ? parseInt(targetUrl.port)
    : (targetUrl.protocol === 'https:' ? 443 : 80);

  const options = {
    hostname: targetUrl.hostname,
    port,
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers: filterRequestHeaders(req.headers, targetUrl.host),
    // Follow redirects manually so we can rewrite Location headers
    agent: false,
  };

  // Stream request body for POST/PUT/PATCH
  const requestBody = await new Promise((resolve) => {
    if (['GET','HEAD','OPTIONS'].includes(req.method.toUpperCase())) {
      resolve(null);
      return;
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

  const upstream = lib.request(options, (upRes) => {
    // Handle redirects (3xx)
    if ([301,302,303,307,308].includes(upRes.statusCode)) {
      const location = upRes.headers['location'];
      if (location) {
        const rewritten = rewriteUrl(location, targetUrl.href, pBase);
        res.setHeader('Location', rewritten);
        res.status(upRes.statusCode).end();
        return;
      }
    }

    const contentType = (upRes.headers['content-type'] || '').toLowerCase();
    const isHtml = contentType.includes('text/html');
    const isCss  = contentType.includes('text/css');
    const isJs   = contentType.includes('javascript');
    const isText = isHtml || isCss || isJs || contentType.startsWith('text/');

    // Pass through filtered response headers
    const filteredHeaders = filterResponseHeaders(upRes.headers);
    for (const [k, v] of Object.entries(filteredHeaders)) {
      res.setHeader(k, v);
    }

    if (!isText) {
      // Binary: pipe directly
      res.status(upRes.statusCode);
      upRes.pipe(res);
      return;
    }

    // Text: decompress, rewrite, send
    decompress(upRes, (err, buf) => {
      if (err) { res.status(502).send('Decompression error'); return; }

      let text = buf.toString('utf8');

      if (isHtml) {
        text = rewriteHtml(text, targetUrl.href, pBase);
      } else if (isCss) {
        text = rewriteCss(text, targetUrl.href, pBase);
      } else if (isJs) {
        text = rewriteJs(text, targetUrl.href, pBase);
      }

      res.removeHeader('content-length'); // length changed after rewrite
      res.status(upRes.statusCode).send(text);
    });
  });

  upstream.on('error', (err) => {
    console.error('Upstream error:', err.message);
    res.status(502).send(`<h1>502 Bad Gateway</h1><p>${err.message}</p>`);
  });

  if (requestBody) upstream.write(requestBody);
  upstream.end();
};
