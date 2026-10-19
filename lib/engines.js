/**
 * The four SERP engines: query plan, fetch, parse, and block detection.
 *
 * Each engine module exports the same shape so the tool can treat them
 * uniformly:
 *
 * - `id` / `label` — routing and display identity.
 * - `home()` — the warm-up URL whose Set-Cookie makes a cold request look human.
 * - `variants(query)` — the ordered plan of page-1 queries that makes one engine
 *   yield up to ~100 rows without opening a second page.
 * - `url(query, tuning)` — the page-1 URL, `rn`/`count`/`num` set to the largest
 *   value the engine still honours.
 * - `parse(html, pageUrl, tuning)` — organic rows only, in rank order.
 * - `blocked(html, finalUrl)` — whether the engine served its captcha instead.
 *
 * @module dsh-search/engines
 */

import { absoluteUrl, attribute, clampText, hostOf, splitBlocks, text } from './html.js';

const SNIPPET_MAX = 320;

/** Hosts that are never a result: the engines and their own sub-services. */
const ENGINE_HOSTS = ['bing.com', 'baidu.com', 'sogou.com', 'so.com', '360.cn'];

/**
 * Whether a result URL points back at the search engine's own site.
 *
 * Bing renders a branded-answer module as a normal `b_algo` whose title anchor
 * goes to `bing.com/?setlang=…`; Baidu and Sogou do the same for their own
 * verticals. A row that links to the engine is not a search result.
 *
 * @param url - candidate result URL.
 * @param pageUrl - the SERP URL, whose host is always treated as an engine.
 * @returns true when the URL belongs to an engine host.
 */
export function isEngineHost(url, pageUrl) {
  const host = hostOf(url);
  if (host.length === 0) return false;
  let pageHost = '';
  try {
    pageHost = new URL(pageUrl).hostname.toLowerCase();
  } catch {
    pageHost = '';
  }
  const candidates = [
    ...ENGINE_HOSTS,
    ...(pageHost.startsWith('www.') ? [pageHost.slice(4)] : [pageHost]),
  ].filter((h) => h.length > 0);
  return candidates.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * @typedef {object} SerpRow
 * @property {string} title - result title.
 * @property {string} url - absolute destination URL.
 * @property {string} snippet - excerpt, when the engine ships one.
 * @property {string} site - display host (engine's own citation when present).
 * @property {string} engine - engine id.
 * @property {number} rank - rank within the engine's own result list.
 */

/**
 * Split a snippet-bearing chunk on `<em>` highlighting so titles stay readable,
 * then clamp. Engines highlight query terms; the marks carry no meaning here.
 *
 * @param html - the snippet markup.
 * @returns plain snippet text.
 */
const snippetOf = (html) => clampText(text(html), SNIPPET_MAX);

/**
 * Registrable suffix (eTLD+1) of a hostname, without a public-suffix list.
 *
 * Duplicate detection compares destinations a user would call "the same site";
 * a short suffix table keeps `blog.csdn.net` and `bbs.csdn.net` from collapsing
 * while still joining `www.example.com` and `example.com`.
 *
 * @param host - lowercase hostname.
 * @returns the registrable part, or the host itself for IPs/localhost.
 */
export function registrableSuffix(host) {
  if (host.length === 0) return '';
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const twoLevel = new Set(['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'co.uk', 'co.jp', 'com.hk', 'com.tw', 'co.kr']);
  const lastTwo = parts.slice(-2).join('.');
  if (twoLevel.has(lastTwo)) return parts.slice(-3).join('.');
  return lastTwo;
}

// ── bing ──────────────────────────────────────────────────────────────────────
const bing = {
  id: 'bing',
  label: 'Bing',
  home: () => 'https://www.bing.com/',
  /**
   * Bing serves 10 organic rows per page regardless of `count`, and the
   * `count` parameter changes nothing measurable — so page 1 alone cannot reach
   * 100. `first=11…` would be page 2. The only page-1-preserving way to raise
   * the yield is breadth: several page-1 queries for the same intent.
   *
   * Measured: five variants returned 45–56 rows, seven returned 63–70. Three of
   * the one hundred are therefore per-page overhead — the page repeats its top
   * rows across query variants, and dedupe against title/site keeps the repeats
   * counting toward the harvest while leaving them out of the answer.
   *
   * Variant choice is per engine because each engine's extras differ: Baidu and
   * Sogou run a second query only (their captcha risk is real), Bing and 360
   * carry the full plan.
   *
   * @param query - user query.
   * @returns the ordered variant queries.
   */
  variants: (query) => [
    query,
    `${query} 官网`,
    `${query} 教程`,
    `${query} 文档`,
    `${query} github`,
    `${query} 怎么用`,
    `${query} 对比`,
  ],
  url: (query, tuning) =>
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${tuning.count}&form=QBLH`,
  /**
   * @param html - the page.
   * @param pageUrl - the final URL after redirects (Bing redirects to cn.bing.com).
   * @returns organic rows in rank order.
   */
  parse(html, pageUrl) {
    const rows = [];
    for (const chunk of splitBlocks(html, '<li class="b_algo')) {
      const h2 = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(chunk);
      const anchor = /<a\b[^>]*>[\s\S]*?<\/a>/.exec(h2?.[1] ?? '');
      if (anchor === null) continue;
      const openTag = /<a\b[^>]*>/.exec(anchor[0])?.[0] ?? '';
      const url = absoluteUrl(attribute(openTag, 'href'), pageUrl);
      const title = text(anchor[0]);
      // A branded-answer module ("Bing", "搜索 - Microsoft 必应") renders as a
      // b_algo whose h2 links back into bing.com itself. Dropping rows whose
      // destination sits on the engine's own host is what keeps that noise out.
      if (url === undefined || title.length === 0 || isEngineHost(url, pageUrl)) continue;
      const caption = /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(chunk);
      const cite = /<cite[^>]*>([\s\S]*?)<\/cite>/.exec(chunk);
      rows.push({
        title,
        url,
        snippet: caption === null ? '' : snippetOf(caption[1]),
        site: cite === null ? hostOf(url) : text(cite[1]),
      });
    }
    return rows;
  },
  blocked: (html) => /unusual traffic|checking your browser|已被阻止|拒绝访问/i.test(html) && !html.includes('b_algo'),
  /**
   * Bing's own result list exposes `first=10|20` next-page links even when the
   * page renders ten rows; reporting the depth keeps the caller honest about
   * what "page 1 only" cost.
   *
   * @param html - the page.
   * @returns 1 — the tool never follows a next-page link.
   */
  pagesFetched: () => 1,
};

// ── baidu ─────────────────────────────────────────────────────────────────────
const BAIDU_WRAPPER = 'https://www.baidu.com/s';

/**
 * Baidu links are not the destination: they are `/link?url=<opaque>` wrappers,
 * and the `mu` attribute on the same anchor carries the real URL when present.
 *
 * @param href - the anchor href.
 * @param mu - the anchor's `mu` attribute.
 * @param pageUrl - the page URL for absolutisation.
 * @returns the destination URL, or `undefined`.
 */
function baiduTarget(href, mu, pageUrl) {
  const fromMu = absoluteUrl(mu, pageUrl);
  if (fromMu !== undefined) return fromMu;
  const resolved = absoluteUrl(href, pageUrl);
  if (resolved === undefined) return undefined;
  try {
    const parsed = new URL(resolved);
    if (parsed.hostname.endsWith('baidu.com') && parsed.pathname === '/link') {
      // The wrapper itself is useless as a destination; keep it only so the
      // caller still sees a link rather than dropping the row.
      return parsed.href;
    }
  } catch {
    return resolved;
  }
  return resolved;
}

const baidu = {
  id: 'baidu',
  label: '百度',
  home: () => 'https://www.baidu.com/',
  /**
   * Baidu honours `rn=50` on a single page-1 request — the one engine that can
   * approach 100 rows without paging — but it is the strictest about pacing:
   * one cold session usually lands on the captcha page, and a session that has
   * already answered stays usable longer. `rn=30` measured worse than both 20
   * and 50 (0 rows), so the plan keeps the widest value and a second variant
   * only, because a captcha costs the whole engine.
   *
   * @param query - user query.
   * @returns the ordered variant queries.
   */
  variants: (query) => [query, `${query} 官网`],
  url: (query, tuning) => `${BAIDU_WRAPPER}?wd=${encodeURIComponent(query)}&rn=${tuning.rn}&ie=utf-8`,
  parse(html, pageUrl) {
    const rows = [];
    for (const chunk of splitBlocks(html, 'class="result c-container')) {
      const h3 = /<h3[^>]*>([\s\S]*?)<\/h3>/.exec(chunk);
      const anchor = /<a\b[^>]*>[\s\S]*?<\/a>/.exec(h3?.[1] ?? '');
      if (anchor === null) continue;
      const openTag = /<a\b[^>]*>/.exec(anchor[0])?.[0] ?? '';
      const url = baiduTarget(attribute(openTag, 'href'), attribute(openTag, 'mu'), pageUrl);
      if (url === undefined) continue;
      const title = text(anchor[0]);
      if (title.length === 0) continue;
      const showUrl = /class="c-showurl[^"]*"[^>]*>([\s\S]*?)<\//.exec(chunk);
      rows.push({
        title,
        url,
        snippet: '',
        site: showUrl === null ? hostOf(url) : text(showUrl[1]),
      });
    }
    return rows;
  },
  blocked: (html, finalUrl) =>
    finalUrl.includes('wappass.baidu.com') || /安全验证|请输入验证码|网络不给力/.test(html.slice(0, 4000)),
};

// ── sogou ─────────────────────────────────────────────────────────────────────
/**
 * Sogou's `/link?url=<opaque>` wrappers cannot be decoded offline. When the
 * anchor is such a wrapper and no inline target exists, the row still ranks —
 * the caller reports the wrapper and marks it as unresolved.
 *
 * @param href - the anchor href.
 * @param pageUrl - the page URL.
 * @returns the destination, or the wrapper URL.
 */
function sogouTarget(href, pageUrl) {
  const resolved = absoluteUrl(href, pageUrl);
  if (resolved === undefined) return undefined;
  try {
    const parsed = new URL(resolved);
    if (parsed.pathname === '/link' && parsed.searchParams.get('url') !== null) {
      const inner = parsed.searchParams.get('url');
      const absolute = absoluteUrl(inner, pageUrl);
      if (absolute !== undefined) return absolute;
    }
  } catch {
    return resolved;
  }
  return resolved;
}

const sogou = {
  id: 'sogou',
  label: '搜狗',
  home: () => 'https://www.sogou.com/',
  /**
   * Sogou tolerates two page-1 queries before the seccode interstitial appears.
   *
   * @param query - user query.
   * @returns the ordered variant queries.
   */
  variants: (query) => [query, `${query} 官网`],
  url: (query, tuning) => `https://www.sogou.com/web?query=${encodeURIComponent(query)}&num=${tuning.num}`,
  parse(html, pageUrl) {
    const rows = [];
    for (const chunk of splitBlocks(html, 'class="vrwrap')) {
      const h3 = /<h3[^>]*>([\s\S]*?)<\/h3>/.exec(chunk);
      const anchor = /<a\b[^>]*>[\s\S]*?<\/a>/.exec(h3?.[1] ?? '');
      if (anchor === null) continue;
      const openTag = /<a\b[^>]*>/.exec(anchor[0])?.[0] ?? '';
      const url = sogouTarget(attribute(openTag, 'href'), pageUrl);
      if (url === undefined) continue;
      const title = text(anchor[0]);
      if (title.length === 0) continue;
      const cite = /class="citeurl"[^>]*>([\s\S]*?)<\//.exec(chunk);
      const summary = /class="star-wiki"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/.exec(chunk) ?? /<p[^>]*class="[^"]*str_info[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(chunk);
      rows.push({
        title,
        url,
        snippet: summary === null ? '' : snippetOf(summary[1]),
        site: cite === null ? hostOf(url) : text(cite[1]),
      });
    }
    return rows;
  },
  blocked: (html) => /verify\.css|antispider|id="seccodeForm"|seccodeInput/.test(html),
};

// ── so360 ─────────────────────────────────────────────────────────────────────
const so360 = {
  id: 'so360',
  label: '360 搜索',
  home: () => 'https://www.so.com/',
  /**
   * 360 answers a page-1 request with 7–15 rows depending on the query's ad
   * density; `pn=` beyond 1 returns nothing, so breadth is the only lever. It
   * blocks a residential IP harder than Sogou does, so its plan is long but its
   * cooldown is the longest: one block costs the engine for minutes.
   *
   * @param query - user query.
   * @returns the ordered variant queries.
   */
  variants: (query) => [
    query,
    `${query} 官网`,
    `${query} 教程`,
    `${query} 文档`,
    `${query} 介绍`,
    `${query} 推荐`,
    `${query} 下载`,
  ],
  url: (query, tuning) => `https://www.so.com/s?q=${encodeURIComponent(query)}&pn=1&rn=${tuning.rn}`,
  parse(html, pageUrl) {
    const rows = [];
    for (const chunk of splitBlocks(html, '<li class="res-list')) {
      const mdurl = /data-mdurl="(https?:\/\/[^"]+)"/.exec(chunk);
      const h3 = /<h3[^>]*>([\s\S]*?)<\/h3>/.exec(chunk);
      const anchor = /<a\b[^>]*>[\s\S]*?<\/a>/.exec(h3?.[1] ?? '');
      const url = absoluteUrl(mdurl?.[1], pageUrl) ?? absoluteUrl(
        anchor === null ? undefined : attribute(/<a\b[^>]*>/.exec(anchor[0])?.[0] ?? '', 'href'),
        pageUrl,
      );
      if (url === undefined) continue;
      const title = anchor === null ? '' : text(anchor[0]);
      if (title.length === 0) continue;
      const cite = /<cite[^>]*>([\s\S]*?)<\/cite>/.exec(chunk);
      const summary = /<p[^>]*class="res-desc"[^>]*>([\s\S]*?)<\/p>/.exec(chunk) ?? /<div[^>]*class="res-rich[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(chunk);
      rows.push({
        title,
        url,
        snippet: summary === null ? '' : snippetOf(summary[1]),
        site: cite === null ? hostOf(url) : text(cite[1]),
      });
    }
    return rows;
  },
  blocked: (html, finalUrl) => finalUrl.includes('qcaptcha.so.com') || /qcaptcha/.test(finalUrl),
};

/** Registry keyed by the ids the tool and config use. */
export const ENGINES = { bing, baidu, sogou, so360 };

/** Stable display order. */
export const ENGINE_IDS = ['bing', 'baidu', 'sogou', 'so360'];

/**
 * Resolve a site argument into engine ids.
 *
 * @param sites - user-supplied ids, aliases or engine hostnames.
 * @returns the engine ids to query, in `ENGINE_IDS` order.
 * @throws {Error} naming the unknown site.
 */
export function resolveSites(sites) {
  const aliases = {
    bing: 'bing',
    'bing.com': 'bing',
    cn_bing: 'bing',
    baidu: 'baidu',
    'baidu.com': 'baidu',
    sogou: 'sogou',
    'sogou.com': 'sogou',
    so: 'so360',
    'so.com': 'so360',
    '360': 'so360',
    so360: 'so360',
  };
  const picked = new Set();
  for (const raw of sites) {
    const key = String(raw).trim().toLowerCase();
    const id = aliases[key];
    if (id === undefined) {
      throw new Error(`unknown site "${raw}"; use one of ${ENGINE_IDS.join(', ')} (or their hostnames)`);
    }
    picked.add(id);
  }
  return ENGINE_IDS.filter((id) => picked.has(id));
}
