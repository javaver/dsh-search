/**
 * Chrome DevTools Protocol browser mode — the escape hatch for engines that
 * answer a plain HTTP client with a captcha.
 *
 * Status: scaffolded, NOT wired into the default path. `lib/tool.js` runs the
 * HTTP session only; enabling this module needs `config.cdp = true` plus a
 * Chrome started with `--remote-debugging-port`.
 *
 * Design constraints that shape the code below:
 *
 * - Same output contract as the HTTP path: `{ status, url, html }`, so the
 *   engine parsers never learn which transport produced the page.
 * - Page 1 only. The module navigates to the engine's page-1 URL and never
 *   follows its next-page link.
 * - One tab per engine, reused across calls, so the browser's own cookie jar
 *   keeps the warm-up state the HTTP path has to reconstruct by hand.
 *
 * @module dsh-search/cdp
 */

const DEFAULT_ENDPOINT = 'http://127.0.0.1:9222';

/**
 * Minimal CDP client over the browser's HTTP discovery + WebSocket endpoint.
 * @param endpoint - `http://host:port` of the DevTools endpoint.
 * @returns the client, or throws when the browser is not reachable.
 */
export async function connect(endpoint = DEFAULT_ENDPOINT) {
  let version;
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, '')}/json/version`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    version = await res.json();
  } catch (error) {
    throw new Error(
      `CDP endpoint ${endpoint} is unreachable (${String(error)}). Start Chrome with ` +
        `--remote-debugging-port=9222, or set config.cdpEndpoint.`,
    );
  }
  if (typeof version.webSocketDebuggerUrl !== 'string') {
    throw new Error(`CDP endpoint ${endpoint} did not report webSocketDebuggerUrl`);
  }
  return new CdpClient(endpoint, version.webSocketDebuggerUrl);
}

/**
 * One CDP connection, one command at a time.
 */
class CdpClient {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #tabs = new Map();

  /**
   * @param endpoint - discovery endpoint (kept for target creation).
   * @param socketUrl - browser-level WebSocket URL.
   */
  constructor(endpoint, socketUrl) {
    this.endpoint = endpoint;
    this.socketUrl = socketUrl;
    this.#socket = new WebSocket(socketUrl);
    this.ready = new Promise((resolve, reject) => {
      this.#socket.addEventListener('open', () => resolve(), { once: true });
      this.#socket.addEventListener('error', (event) => reject(new Error(`CDP socket error: ${String(event)}`)), { once: true });
    });
    this.#socket.addEventListener('message', (event) => this.#onMessage(event));
  }

  /** @param event - a WebSocket message event. */
  #onMessage(event) {
    let payload;
    try {
      payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    const waiter = payload.id === undefined ? undefined : this.#pending.get(payload.id);
    if (waiter === undefined) return;
    this.#pending.delete(payload.id);
    if (payload.error !== undefined) waiter.reject(new Error(payload.error.message ?? 'CDP error'));
    else waiter.resolve(payload.result);
  }

  /**
   * Send one command and await its result.
   *
   * @param method - CDP method name.
   * @param params - method parameters.
   * @param sessionId - optional flattened session (a target's own channel).
   * @returns the method result.
   */
  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    const message = JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) });
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(message);
    });
  }

  /**
   * Create or reuse a tab and attach a flattened session to it.
   *
   * @param key - stable name for the tab (the engine id).
   * @returns the session id.
   */
  async tab(key) {
    const existing = this.#tabs.get(key);
    if (existing !== undefined) return existing;
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    this.#tabs.set(key, sessionId);
    return sessionId;
  }

  /**
   * Navigate a tab and return its DOM once `readyState` settles.
   *
   * @param key - tab key (engine id).
   * @param url - page-1 SERP URL.
   * @param options - navigation policy.
   * @param options.timeoutMs - hard bound for one navigation.
   * @param options.settleMs - quiet period after load before reading the DOM.
   * @returns the same shape the HTTP session returns.
   */
  async navigate(key, url, options) {
    const sessionId = await this.tab(key);
    await this.send('Page.enable', {}, sessionId);
    await this.send('Page.navigate', { url }, sessionId);

    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`CDP navigation to ${url} timed out`);
      await new Promise((r) => setTimeout(r, 250));
      const state = await this.send(
        'Runtime.evaluate',
        { expression: 'document.readyState', returnByValue: true },
        sessionId,
      );
      if (state?.result?.value === 'complete') break;
    }
    if (options.settleMs > 0) await new Promise((r) => setTimeout(r, options.settleMs));

    const [doc, href] = await Promise.all([
      this.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true }, sessionId),
      this.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId),
    ]);
    return { status: 200, url: String(href?.result?.value ?? url), html: String(doc?.result?.value ?? '') };
  }

  /** Close every tab this client created and drop the socket. */
  async dispose() {
    for (const sessionId of this.#tabs.values()) {
      await this.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
    }
    this.#tabs.clear();
    this.#socket.close();
  }
}
