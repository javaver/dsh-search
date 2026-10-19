/**
 * Persistent cookie jar + a hardcoded-Chrome HTTP client for SERP fetching.
 *
 * Why not fetch(): the four engines are routed by cookie, not by query. Baidu
 * only serves results after a home-page handshake hands out BAIDUID; 360 and
 * Sogou answer a cold request with a captcha interstitial. A per-engine jar
 * retained across calls turns that handshake into one extra request at startup
 * instead of one per search.
 *
 * Why node:https rather than fetch(): Node 24 ships `Agent({ proxyEnv })`, which
 * honours HTTPS_PROXY/NO_PROXY with CONNECT tunnelling — the same policy the
 * harness already applies to fetch (dsh-http-proxy) — while leaving cookies,
 * redirects and per-engine pacing under this plugin's control.
 *
 * @module dsh-search/http
 */

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

/** Chrome/131 on Windows: the fingerprint the four engines currently accept. */
const CHROME_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'accept-encoding': 'gzip, deflate, br',
  'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
};

const MAX_REDIRECTS = 6;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Decompress a response body by its `content-encoding`.
 *
 * @param buf - the raw body.
 * @param encoding - the response's content-encoding header.
 * @returns the decoded bytes; the raw buffer when the encoding is unknown or
 *   already decoded, because a mislabelled body is still worth parsing.
 */
function decompress(buf, encoding) {
  const enc = (encoding ?? '').toLowerCase();
  const safe = (fn) => {
    try {
      return fn(buf);
    } catch {
      return buf;
    }
  };
  if (enc.includes('br')) return safe(zlib.brotliDecompressSync);
  if (enc.includes('gzip')) return safe(zlib.gunzipSync);
  if (enc.includes('deflate')) return safe(zlib.inflateSync);
  return buf;
}

/**
 * Decode a body with the engine's charset.
 *
 * GB18030 is a superset of GBK/GB2312 and throws on real Big5 content, so it is
 * tried first and Big5 is the fallback; UTF-8 covers every modern layout. The
 * bytes are never trusted to declare their own charset.
 *
 * @param buf - the raw body bytes.
 * @returns the decoded HTML.
 */
export function decodeHtml(buf) {
  for (const label of ['gb18030', 'big5']) {
    try {
      return new TextDecoder(label, { fatal: true }).decode(buf);
    } catch {
      /* try the next charset */
    }
  }
  return new TextDecoder('utf-8').decode(buf);
}

/** One cookie per name, last writer wins — what a browser does on Set-Cookie. */
export class CookieJar {
  #byHost = new Map();

  /**
   * Record every Set-Cookie line of a response.
   *
   * @param host - the hostname the response came from.
   * @param lines - raw Set-Cookie values.
   */
  absorb(host, lines) {
    if (!lines) return;
    let jar = this.#byHost.get(host);
    if (jar === undefined) {
      jar = new Map();
      this.#byHost.set(host, jar);
    }
    for (const line of lines) {
      const pair = line.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  /**
   * Build the Cookie header for a host, including parent-domain cookies
   * (`.sogou.com` applies to `www.sogou.com`).
   *
   * @param host - target hostname.
   * @returns the header value, or `undefined` when the jar has nothing.
   */
  header(host) {
    const parts = [];
    for (const [cookieHost, jar] of this.#byHost) {
      const same = cookieHost === host || host.endsWith(`.${cookieHost}`);
      if (!same) continue;
      for (const [name, value] of jar) parts.push(`${name}=${value}`);
    }
    return parts.length > 0 ? parts.join('; ') : undefined;
  }

  /** @returns how many distinct hosts hold cookies (diagnostics). */
  get hostCount() {
    return this.#byHost.size;
  }
}

/**
 * One SERP request/response pair.
 * @typedef {object} HttpResult
 * @property {number} status - HTTP status of the final hop.
 * @property {string} url - final URL after redirects.
 * @property {string} html - decoded body.
 */

/**
 * A per-engine HTTP session: one keep-alive agent, one cookie jar, one pacing slot.
 */
export class EngineSession {
  #agent;
  #jar = new CookieJar();
  #queue = Promise.resolve();
  #lastAt = 0;

  /**
   * @param options - session policy.
   * @param options.concurrency - parallel requests allowed for this engine.
   * @param options.minGapMs - minimum spacing between request starts.
   * @param options.timeoutMs - per-request socket timeout.
   * @param options.proxy - `HTTPS_PROXY`-style URL; empty means direct.
   */
  constructor({ concurrency, minGapMs, timeoutMs, proxy }) {
    const proxyEnv = {};
    if (typeof proxy === 'string' && proxy.trim().length > 0) {
      proxyEnv.HTTPS_PROXY = proxy.trim();
      proxyEnv.HTTP_PROXY = proxy.trim();
    }
    this.#agent = new https.Agent({
      keepAlive: true,
      maxSockets: Math.max(1, concurrency),
      maxCachedSessions: 0,
      ...(Object.keys(proxyEnv).length > 0 ? { proxyEnv } : {}),
    });
    this.minGapMs = Math.max(0, minGapMs);
    this.timeoutMs = Math.max(1000, timeoutMs);
  }

  /**
   * Serialise request starts against this engine's own pacing slot.
   *
   * @template T
   * @param work - the request to run.
   * @returns the request's result.
   */
  #paced(work) {
    const run = this.#queue.then(async () => {
      const wait = this.#lastAt + this.minGapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.#lastAt = Date.now();
      return work();
    });
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * GET a URL through this session, following redirects and absorbing cookies.
   *
   * @param url - absolute URL.
   * @param options - per-request extras.
   * @param options.referer - Referer header.
   * @param options.signal - caller cancellation.
   * @returns the final hop's status, URL and decoded body.
   */
  get(url, options = {}) {
    return this.#paced(() => this.#get(url, options, 0));
  }

  async #get(url, options, depth) {
    const { signal } = options;
    if (signal?.aborted === true) throw new Error('request aborted');

    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const headers = { ...CHROME_HEADERS };
    if (typeof options.referer === 'string') headers.referer = options.referer;
    const cookie = this.#jar.header(target.hostname);
    if (cookie !== undefined) headers.cookie = cookie;

    const raw = await new Promise((resolve, reject) => {
      const request = (isHttps ? https : http).request(
        {
          host: target.hostname,
          port: target.port.length > 0 ? Number(target.port) : isHttps ? 443 : 80,
          path: `${target.pathname}${target.search}`,
          method: 'GET',
          headers,
          ...(isHttps ? { agent: this.#agent, servername: target.hostname } : {}),
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
              res.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            this.#jar.absorb(target.hostname, res.headers['set-cookie']);
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: decompress(Buffer.concat(chunks), res.headers['content-encoding']),
            });
          });
          res.on('error', reject);
        },
      );
      request.on('timeout', () => request.destroy(new Error(`${target.hostname} timed out after ${this.timeoutMs} ms`)));
      request.on('error', (error) => {
        reject(new Error(`${target.hostname} request failed: ${error.message}`));
      });
      if (signal !== undefined) {
        const onAbort = () => request.destroy(new Error('request aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        request.on('close', () => signal.removeEventListener('abort', onAbort));
      }
      request.end();
    });

    const location = raw.headers.location;
    if (raw.status >= 300 && raw.status < 400 && typeof location === 'string' && depth < MAX_REDIRECTS) {
      const next = new URL(location, target).href;
      return this.#get(next, options, depth + 1);
    }
    return { status: raw.status, url: target.href, html: decodeHtml(raw.body) };
  }

  /** Release sockets once the engine is no longer used. */
  dispose() {
    this.#agent.destroy();
  }
}
