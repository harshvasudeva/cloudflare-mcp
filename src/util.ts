/** Shared helpers used by every tool module. */

import { z } from "zod";

/**
 * A free-form JSON object parameter.
 *
 * Prefer this over `z.record(z.any())`: it serialises to
 * `{"type":"object","additionalProperties":true}`, the form every MCP client
 * accepts, whereas `z.record` emits `additionalProperties: {}` which stricter
 * clients (Gemini/Antigravity, some Codex validators) can reject.
 */
export const jsonObject = () => z.object({}).passthrough();

/** Wraps a value as an MCP text result containing pretty-printed JSON. */
export function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** Wraps an already-formatted string as an MCP text result. */
export function rawResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Safety gate for destructive / live-affecting operations. Every tool that
 * deletes something, or overwrites production state (deploys, cache purges),
 * routes through this so an agent has to be deliberate.
 */
export function requireConfirm(confirm: boolean | undefined, action: string): void {
  if (!confirm) {
    throw new Error(`Refusing to ${action}: pass confirm=true to proceed.`);
  }
}

/** Drops undefined values so PATCH bodies only carry fields the caller actually set. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}
