/**
 * The `serp_search` tool: one call, four engines, page 1 only, up to ~100 rows.
 *
 * The tool is deliberately not a `ctx.web` search provider. A provider would
 * answer the `web_search` contract (top-N sources for a query) and let the seam
 * truncate; this plugin's whole point is the opposite — a deliberately wide,
 * paged-nowhere harvest that also reports what each engine did. Registering it
 * as its own tool keeps `web_search` unambiguously the DeepSeek-native path.
 *
 * @module dsh-search/tool
 */

import { ENGINE_IDS, ENGINES, resolveSites } from './engines.js';
import { EngineSession } from './http.js';
import { mergeRows, renderRows } from './merge.js';
import { faviconFor } from './favicon.js';
import { connect } from './cdp.js';

/** Hosts that are never results: the engines themselves and their sub-services. */
const ENGINE_HOSTS = ['bing.com', 'baidu.com', 'sogou.com', 'so.com', '360.cn'];

const TOOL_NAME = 'serp_search';

/**
 * Hold one HTTP session per engine, each engine's block cooldown, and the
 * optional CDP connection used by browser mode.
 */
class SessionPool {
  #sessions = new Map();
  #blockedUntil = new Map();
  #cdp;

  /**
   * @param config - the effective plugin config.
   */
  constructor(config) {
    this.config = config;
  }

  /**
   * @param id - engine id.
   * @returns the engine's session, created on first use.
   */
  session(id) {
    let session = this.#sessions.get(id);
    if (session === undefined) {
      const tuning = this.config.engines[id];
      session = new EngineSession({
        concurrency: tuning.concurrency,
        minGapMs: tuning.minGapMs,
        timeoutMs: this.config.timeoutMs,
        proxy: this.config.httpProxy,
      });
      this.#sessions.set(id, session);
    }
    return session;
  }

  /**
   * @param id - engine id.
   * @returns the epoch ms until which the engine is skipped, or 0.
   */
  blockedUntil(id) {
    return this.#blockedUntil.get(id) ?? 0;
  }

  /**
   * @param id - engine id.
   * @param ms - cooldown length.
   */
  markBlocked(id, ms) {
    this.#blockedUntil.set(id, Date.now() + Math.max(1000, ms));
  }

  /**
   * Lazily connect the browser used by `config.cdp` mode, once per pool.
   *
   * @returns the CDP client.
   */
  async cdpClient() {
    if (this.#cdp === undefined) this.#cdp = await connect(this.config.cdpEndpoint);
    return this.#cdp;
  }

  /** Release every socket and browser tab. */
  dispose() {
    for (const session of this.#sessions.values()) session.dispose();
    this.#sessions.clear();
    const cdp = this.#cdp;
    this.#cdp = undefined;
    if (cdp !== undefined) void cdp.dispose().catch(() => undefined);
  }
}

/**
 * Run one engine's plan and collect its rows.
 *
 * Each variant is a separate page-1 request; the first blocked response stops
 * the engine (further variants would only deepen the block) and arms its
 * cooldown.
 *
 * @param engineId - engine id.
 * @param query - user query.
 * @param pool - session pool.
 * @param config - effective config.
 * @param signal - caller cancellation.
 * @returns the engine's rows and a diagnostic line.
 */
async function runEngine(engineId, query, pool, config, signal) {
  const engine = ENGINES[engineId];
  const tuning = config.engines[engineId];
  const startedAt = Date.now();
  const until = pool.blockedUntil(engineId);
  if (until > startedAt) {
    return {
      rows: [],
      diagnostic: `${engine.label}: skipped — cooling down for ${Math.ceil((until - startedAt) / 1000)}s`,
    };
  }

  const session = pool.session(engineId);
  const rows = [];
  let requests = 0;
  let blockReason = '';

  try {
    for (const variant of engine.variants(query)) {
      if (signal?.aborted === true) break;
      let page;
      let lastError;
      for (let attempt = 0; attempt <= config.retries; attempt += 1) {
        try {
          page = await fetchPage(engine, engine.url(variant, tuning), session, pool, config, signal);
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          if (signal?.aborted === true) break;
        }
      }
      requests += 1;
      if (page === undefined) {
        blockReason = `request failed (${lastError instanceof Error ? lastError.message : String(lastError)})`;
        break;
      }
      if (engine.blocked(page.html, page.url)) {
        blockReason = 'captcha / anti-bot page';
        pool.markBlocked(engineId, tuning.cooldownMs);
        break;
      }
      const parsed = engine.parse(page.html, page.url);
      rows.push(...parsed);
    }
  } catch (error) {
    blockReason = error instanceof Error ? error.message : String(error);
  }

  const ms = Date.now() - startedAt;
  const diagnostic =
    rows.length === 0
      ? `${engine.label}: 0 rows (${requests} request${requests === 1 ? '' : 's'}, ${ms} ms)${blockReason.length > 0 ? ` — ${blockReason}` : ''}`
      : `${engine.label}: ${rows.length} rows (${requests} request${requests === 1 ? '' : 's'}, ${ms} ms)${blockReason.length > 0 ? ` — stopped early: ${blockReason}` : ''}`;
  return { rows, diagnostic };
}

/**
 * Fetch one SERP page through the configured transport.
 *
 * Browser mode (`config.cdp`) drives a Chrome tab through the DevTools
 * protocol; HTTP mode is the default. Both return the same
 * `{ status, url, html }` shape, so the parsers never branch on transport.
 *
 * @param engine - the engine module.
 * @param url - the page-1 URL.
 * @param session - the engine's HTTP session.
 * @param pool - session pool (owns the CDP client in browser mode).
 * @param config - effective config.
 * @param signal - caller cancellation.
 * @returns the fetched page.
 */
async function fetchPage(engine, url, session, pool, config, signal) {
  if (!config.cdp) return session.get(url, { signal, referer: engine.home() });
  const client = await pool.cdpClient();
  return client.navigate(engine.id, url, {
    timeoutMs: config.timeoutMs,
    settleMs: config.cdpSettleMs,
  });
}

/**
 * Register the tool against a context that owns a tool registry.
 *
 * @param ctx - the plugin context.
 * @param config - the effective plugin config.
 */
export function applySerpTool(ctx, config) {
  const pool = new SessionPool(config);
  ctx.effect?.(() => () => pool.dispose());

  const sitesProperty = (() => {
    const schema = {
      type: 'array',
      items: { type: 'string', enum: ENGINE_IDS },
      description:
        'Engines to query, in the order you want them interleaved. Omit to use every enabled engine.',
    };
    if (config.defaultSites.length > 0) schema.default = config.defaultSites;
    return schema;
  })();

  ctx.tools.register({
    name: TOOL_NAME,
    description:
      'Wide first-page sweep across Chinese and global engines (bing.com, baidu.com, sogou.com, so.com). ' +
      'Each engine is asked page 1 only; one call returns up to ~100 deduplicated rows with title, URL, snippet and engine tag. ' +
      'Use it when breadth matters: competitive landscape, “what does the Chinese web say”, keyword coverage. ' +
      'Use web_search instead for a single focused answer.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'The query, verbatim. Chinese or English; the engines handle either.',
        },
        sites: sitesProperty,
        maxResults: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          default: config.maxResults,
          description: 'Cap on returned rows after dedupe (default 100).',
        },
        dedupe: {
          type: 'boolean',
          default: config.dedupe,
          description: 'Drop repeated URLs and near-identical titles across engines (default true).',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                rank: { type: 'integer', required: true },
                title: { type: 'string', required: true },
                url: { type: 'string', required: true },
                snippet: { type: 'string' },
                site: { type: 'string' },
                engine: { type: 'string', required: true },
                favicon: { type: 'string' },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
          diagnostics: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderRows(value.query, value.results, value.diagnostics, value.truncated) }],
      presentationMeta: (_args, value) => ({
        kind: 'search',
        sources: value.results.map((row) => ({
          url: row.url,
          title: row.title,
          ...(row.snippet !== undefined && row.snippet.length > 0 ? { snippet: row.snippet } : {}),
          ...(row.favicon !== undefined && row.favicon.length > 0 ? { favicon: row.favicon } : {}),
        })),
        truncated: value.truncated,
      }),
    },
    timeoutMs: Math.max(config.timeoutMs * 4, 90_000),
    isConcurrencySafe: () => true,
    /**
     * Pending-call card: the query, tagged as a search so the client can show
     * its search affordance. Mirrors the shape `@deepseek-ai/dsh-tool-web` uses.
     *
     * @param args - the raw tool arguments.
     * @returns the generic card view.
     */
    presentCall: (args) => ({
      card: 'generic',
      title: typeof args?.query === 'string' ? args.query : 'serp_search',
      kind: 'search',
      rawInput: typeof args?.query === 'string' ? args.query : '',
    }),
    /**
     * Completed-call card: reuse the `web` source-list view so one query's
     * results render exactly like a `web_search` result, engine tags included
     * in each source's snippet.
     *
     * @param args - the raw tool arguments.
     * @param result - the canonical tool result (`{ value, isError, meta }` in
     *   the harness, or a bare value when rendered directly).
     * @returns the source-list view, or `undefined` for a failure.
     */
    presentResult: (args, result) => {
      const value = result?.value ?? result;
      if (result?.isError === true || value === undefined || !Array.isArray(value.results)) return undefined;
      return {
        card: 'web',
        kind: 'search',
        title: value.query,
        sources: value.results.map((row) => ({
          url: row.url,
          title: row.title,
          ...(row.snippet !== undefined && row.snippet.length > 0
            ? { snippet: `${row.snippet} · ${row.engine}` }
            : { snippet: row.engine }),
          ...(row.favicon !== undefined && row.favicon.length > 0 ? { favicon: row.favicon } : {}),
        })),
        truncated: value.truncated === true,
      };
    },
    async execute(args, exec) {
      const query = String(args.query ?? '').trim();
      if (query.length === 0) throw new Error('query must be a non-empty string');

      const requested = Array.isArray(args.sites) && args.sites.length > 0 ? args.sites.map(String) : config.defaultSites;
      const selected = resolveSites(requested).filter((id) => config.engines[id].enabled);
      if (selected.length === 0) throw new Error('no engine is selected and enabled');

      const limit = Number.isInteger(args.maxResults) && args.maxResults > 0 ? args.maxResults : config.maxResults;
      const dedupe = args.dedupe !== false && config.dedupe;

      const outcomes = await Promise.all(
        selected.map((id) => runEngine(id, query, pool, config, exec.signal)),
      );

      const merged = mergeRows(
        selected.map((id, index) => [id, outcomes[index].rows]),
        { limit, dedupe, exclude: ENGINE_HOSTS },
      );
      const harvested = outcomes.reduce((sum, outcome) => sum + outcome.rows.length, 0);

      if (config.fetchFavicons && merged.length > 0) {
        const icons = await Promise.all(
          merged.slice(0, 40).map((row) => faviconFor(row.url, exec.signal).catch(() => '')),
        );
        merged.forEach((row, index) => {
          // `favicon` is only set for the rows the card actually renders.
          if (icons[index] !== undefined && icons[index].length > 0) row.favicon = icons[index];
        });
      }

      const diagnostics = [
        ...outcomes.map((outcome) => outcome.diagnostic),
        `harvested ${harvested} rows, ${merged.length} after dedupe${dedupe ? '' : ' (dedupe off)'}`,
      ];

      return {
        query,
        results: merged.map((row) => ({
          rank: row.rank,
          title: row.title,
          url: row.url,
          ...(row.snippet.length > 0 ? { snippet: row.snippet } : {}),
          ...(row.site.length > 0 ? { site: row.site } : {}),
          engine: row.engine,
          ...(row.favicon !== undefined ? { favicon: row.favicon } : {}),
        })),
        truncated: merged.length >= limit && harvested > merged.length,
        diagnostics,
      };
    },
  });
}

export { TOOL_NAME };
