/**
 * @module dsh-search/config
 */

/** Engine tuning defaults; one entry per engine id. */
export const DEFAULT_ENGINES = {
  bing: { enabled: true, count: 50, concurrency: 1, minGapMs: 700, cooldownMs: 60_000 },
  baidu: { enabled: true, rn: 50, concurrency: 1, minGapMs: 1200, cooldownMs: 180_000 },
  sogou: { enabled: true, num: 50, concurrency: 1, minGapMs: 1000, cooldownMs: 90_000 },
  so360: { enabled: true, rn: 50, concurrency: 1, minGapMs: 1200, cooldownMs: 90_000 },
};

export const DEFAULTS = {
  enabled: true,
  defaultSites: ['bing', 'baidu', 'sogou', 'so360'],
  maxResults: 100,
  engines: DEFAULT_ENGINES,
  timeoutMs: 25_000,
  retries: 1,
  fetchFavicons: true,
  dedupe: true,
  httpProxy: '',
  /** Browser mode is opt-in; see `lib/cdp.js`. */
  cdp: false,
  cdpEndpoint: 'http://127.0.0.1:9222',
  cdpSettleMs: 800,
};

/**
 * Merge the profile's raw config over the defaults, keeping unknown keys out.
 *
 * A bundle row's config reaches `apply` as a plain object, and the harness does
 * not validate it, so every field is coerced here rather than trusted.
 *
 * @param raw - the row's `config`.
 * @returns the effective config.
 */
export function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const engines = {};
  for (const [id, defaults] of Object.entries(DEFAULT_ENGINES)) {
    const override = source.engines?.[id];
    const merged = override !== null && typeof override === 'object' ? { ...defaults, ...override } : defaults;
    engines[id] = {
      enabled: merged.enabled !== false,
      count: positiveInt(merged.count, defaults.count),
      rn: positiveInt(merged.rn, defaults.rn),
      num: positiveInt(merged.num, defaults.num),
      concurrency: positiveInt(merged.concurrency, defaults.concurrency),
      minGapMs: positiveInt(merged.minGapMs, defaults.minGapMs, true),
      cooldownMs: positiveInt(merged.cooldownMs, defaults.cooldownMs, true),
    };
  }
  const sites = Array.isArray(source.defaultSites) && source.defaultSites.length > 0
    ? source.defaultSites.map((s) => String(s))
    : DEFAULTS.defaultSites;
  return {
    enabled: source.enabled !== false,
    defaultSites: sites,
    maxResults: positiveInt(source.maxResults, DEFAULTS.maxResults),
    engines,
    timeoutMs: positiveInt(source.timeoutMs, DEFAULTS.timeoutMs),
    retries: positiveInt(source.retries, DEFAULTS.retries, true),
    fetchFavicons: source.fetchFavicons !== false,
    dedupe: source.dedupe !== false,
    httpProxy: typeof source.httpProxy === 'string' ? source.httpProxy.trim() : '',
    cdp: source.cdp === true,
    cdpEndpoint:
      typeof source.cdpEndpoint === 'string' && source.cdpEndpoint.trim().length > 0
        ? source.cdpEndpoint.trim()
        : DEFAULTS.cdpEndpoint,
    cdpSettleMs: positiveInt(source.cdpSettleMs, DEFAULTS.cdpSettleMs, true),
  };
}

/**
 * @param value - candidate.
 * @param fallback - used when the candidate is not a number.
 * @param allowZero - whether 0 is a valid value (delays and retry counts).
 * @returns a bounded integer.
 */
function positiveInt(value, fallback, allowZero = false) {
  const n = typeof value === 'number' ? Math.floor(value) : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return fallback;
  if (n === 0 && !allowZero) return fallback;
  return n;
}
