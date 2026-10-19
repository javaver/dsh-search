/**
 * Small HTML helpers shared by the engine parsers.
 *
 * The four SERPs are parsed with ordered block splitting rather than a DOM: each
 * engine marks its organic rows with one repeated container opening tag, so
 * splitting on that literal and reading each chunk's first heading anchor is
 * both faster and far less fragile than converting a 500 KB adversarial page
 * into a tree.
 *
 * @module dsh-search/html
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  '#0183': ' ',
  middot: '·',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
};

/**
 * Decode the entities these pages actually use.
 * @param text - raw markup text.
 * @returns the text with named and numeric entities resolved.
 */
function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z#0-9]+);/g, (match, body) => {
    const named = NAMED_ENTITIES[body];
    if (named !== undefined) return named;
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

/**
 * Strip tags, decode entities and collapse whitespace.
 * @param html - markup fragment.
 * @returns plain single-line text.
 */
export function text(html) {
  if (typeof html !== 'string' || html.length === 0) return '';
  return decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Read an attribute from an opening tag's text.
 * @param tag - the opening tag markup.
 * @param name - attribute name.
 * @returns the attribute value with entities decoded, or `undefined`.
 */
export function attribute(tag, name) {
  const re = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = re.exec(tag);
  if (m === null) return undefined;
  const value = m[2] ?? m[3] ?? m[4] ?? '';
  return decodeEntities(value);
}

/**
 * Split a document into the chunks that follow each occurrence of a marker.
 * @param html - the page.
 * @param marker - the literal container opening (e.g. `<li class="b_algo"`).
 * @returns one string per occurrence, each starting at its marker.
 */
export function splitBlocks(html, marker) {
  if (typeof html !== 'string' || html.length === 0) return [];
  return html.split(marker).slice(1);
}

/**
 * Absolute-ise and normalise a result URL.
 *
 * Search engines hand back three shapes: absolute URLs, protocol-relative
 * `//host/path`, and site-relative anchors. Engine-specific redirect wrappers
 * (Bing `/ck/a`, Sogou `/link`) are resolved by the caller before this runs.
 *
 * @param href - the raw attribute value.
 * @param base - the page URL.
 * @returns the absolute URL, or `undefined` when it is neither HTTP nor HTTPS.
 */
export function absoluteUrl(href, base) {
  if (typeof href !== 'string' || href.length === 0) return undefined;
  if (href.startsWith('javascript:') || href.startsWith('#')) return undefined;
  if (href.startsWith('data:')) return undefined;
  let url;
  try {
    url = new URL(href, base);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  url.hash = '';
  return url.href;
}

/**
 * Registrable-ish host of a URL, used for engine/site filtering.
 * @param url - absolute URL.
 * @returns the lowercase hostname, or `''`.
 */
export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Trim a snippet to a bounded length without cutting mid-surrogate.
 * @param value - the snippet text.
 * @param max - maximum characters.
 * @returns the snippet, possibly with an ellipsis.
 */
export function clampText(value, max) {
  if (typeof value !== 'string' || value.length === 0) return '';
  const clean = value.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}
