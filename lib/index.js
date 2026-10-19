/**
 * dsh-search — multi-engine first-page SERP sweep for DeepSeek Harness.
 *
 * Mounted as a bundle row: `inject: ['tools']`, one tool, no seam hijacking.
 * @module dsh-search
 */

import { resolveConfig } from './config.js';
import { applySerpTool, TOOL_NAME } from './tool.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-search';

/** The one service this plugin needs; without it the row stays unmounted. */
export const inject = ['tools'];

export { TOOL_NAME };

/**
 * Register the tool when the row is enabled.
 *
 * @param ctx - the plugin context.
 * @param config - the row's raw config (already a plain object).
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  if (!resolved.enabled) return;
  applySerpTool(ctx, resolved);
}

/** Cordis accepts either the named exports or this default object. */
const plugin = { name, inject, apply };

export default plugin;
