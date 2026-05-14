# Vercel Proxy — Full-Rewriting Reverse Proxy

A production-grade proxy for your own sites, deployed as a Vercel serverless function.
Rewrites HTML, CSS, JS, redirects, and dynamically intercepts runtime navigation.

## Features

- ✅ Full HTML attribute rewriting (`href`, `src`, `action`, `srcset`, `data-src`, `poster`)
- ✅ `<meta refresh>` redirect rewriting
- ✅ Inline `<style>` block CSS `url()` rewriting
- ✅ Inline `<script>` best-effort rewriting (`fetch`, XHR, `location.*`)
- ✅ External CSS file rewriting
- ✅ External JS file rewriting (fetch, XHR, location)
- ✅ **Runtime intercept script** injected into every page:
  - Intercepts `pushState` / `replaceState`
  - Intercepts anchor clicks
  - Intercepts form submissions
  - Patches `window.fetch` and `XMLHttpRequest`
- ✅ 3xx redirect rewriting
- ✅ gzip / brotli / deflate decompression
- ✅ Cookie & auth header passthrough
- ✅ Security headers stripped (CSP, X-Frame-Options, HSTS) for white-labeling
- ✅ CORS headers added

## URL Structure

```
https://proxy.yourdomain.com/?url=https://password.targetsite.com/path
```

## Deploy to Vercel

### 1. Clone / download this project

```bash
# If using git
git init && git add . && git commit -m "init"
```

### 2. Install Vercel CLI

```bash
npm i -g vercel
```

### 3. Deploy

```bash
vercel --prod
```

Vercel will give you a `.vercel.app` URL. Add your custom domain in the Vercel dashboard under **Settings → Domains**.

### 4. Add your custom domain

In the Vercel dashboard:
1. Go to your project → **Settings** → **Domains**
2. Add `proxy.yourdomain.com`
3. Add the CNAME record at your DNS provider pointing to `cname.vercel-dns.com`

### 5. (Optional) Pre-fill your sites as quick-link chips

Edit `public/index.html`, find the `MY_SITES` array, and add your URLs:

```js
const MY_SITES = [
  'https://password.yourdomain.com',
  'https://password.anotherdomain.io',
  // ... up to all 10
];
```

## Local Development

```bash
npm install
npx vercel dev
```

Then visit `http://localhost:3000/?url=https://example.com`

## Limitations & Notes

- **Dynamic JS**: Computed URLs (built from string concatenation at runtime) won't be rewritten by the static pass, but the injected runtime script covers `fetch()` and XHR in the vast majority of cases.
- **WebSockets**: Not supported in Vercel serverless functions (30s max, stateless).
- **Service Workers**: Stripped automatically (won't register on the proxy origin).
- **Vercel 30s timeout**: Long-polling or streaming pages may hit the function timeout. Consider Vercel Edge Functions for streaming use cases.

## File Structure

```
vercel-proxy/
├── api/
│   └── proxy.js        ← Serverless function (all the magic)
├── public/
│   └── index.html      ← Landing page UI
├── vercel.json         ← Routing & function config
├── package.json
└── README.md
```
