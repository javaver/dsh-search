/**
 * Favicon resolution: turn a result URL into a data URL the Web tool card can
 * show without a third-party network call from the browser.
 *
 * @module dsh-search/favicon
 */

import https from 'node:https';
import http from 'node:http';

const MAX_ICON_BYTES = 64 * 1024;
const ICON_TIMEOUT_MS = 6000;
const CACHE_LIMIT = 512;

/** host → `data:image/…;base64,…` or `''` when the host has no usable icon. */
const cache = new Map();

/**
 * @param host - hostname.
 * @param dataUrl - resolved icon (empty string marks "resolved as absent").
 */
function remember(host, dataUrl) {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(host, dataUrl);
}

/**
 * Fetch `favicon.ico`/`favicon.svg` for a host and inline it as a data URL.
 *
 * @param pageUrl - a result URL on that host.
 * @param signal - caller cancellation.
 * @returns the data URL, or `''` when unavailable.
 */
export async function faviconFor(pageUrl, signal) {
  let target;
  try {
    target = new URL(pageUrl);
  } catch {
    return '';
  }
  const host = target.hostname;
  const cached = cache.get(host);
  if (cached !== undefined) return cached;

  const candidates = [`${target.origin}/favicon.ico`, `${target.origin}/favicon.svg`];
  for (const url of candidates) {
    const icon = await fetchIcon(url, signal);
    if (icon.length > 0) {
      remember(host, icon);
      return icon;
    }
  }
  remember(host, '');
  return '';
}

/**
 * @param url - absolute icon URL.
 * @param signal - caller cancellation.
 * @returns a data URL for a small raster/vector icon, or `''`.
 */
function fetchIcon(url, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const request = mod.request(
      {
        host: parsed.hostname,
        path: parsed.pathname,
        method: 'GET',
        timeout: ICON_TIMEOUT_MS,
        headers: { accept: 'image/*', 'user-agent': 'Mozilla/5.0 (compatible; dsh-search)' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          done('');
          return;
        }
        const type = String(res.headers['content-type'] ?? '').split(';')[0].trim();
        if (!/^image\/(png|jpeg|jpg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml)$/i.test(type)) {
          res.resume();
          done('');
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_ICON_BYTES) {
            res.destroy();
            done('');
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (size === 0) {
            done('');
            return;
          }
          done(`data:${type};base64,${Buffer.concat(chunks).toString('base64')}`);
        });
        res.on('error', () => done(''));
      },
    );
    request.on('timeout', () => {
      request.destroy();
      done('');
    });
    request.on('error', () => done(''));
    if (signal !== undefined) {
      const onAbort = () => {
        request.destroy();
        done('');
      };
      signal.addEventListener('abort', onAbort, { once: true });
      request.on('close', () => signal.removeEventListener('abort', onAbort));
    }
    request.end();
  });
}
