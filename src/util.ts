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

/**
 * Account/zone parameters shared by nearly every tool. Hoisted here after
 * their per-file copies drifted into inconsistent wording (two variants for
 * account, four for zone, three tools with no description at all) — one
 * definition means one wording, always in sync with what the resolvers
 * actually do.
 */
export const accountParam = z
  .string()
  .optional()
  .describe("Account ID. Defaults to CF_ACCOUNT_ID, else the first account the token can see.");

export const zoneParam = z
  .string()
  .optional()
  .describe("Zone name or zone ID. Defaults to CF_ZONE from server config if omitted.");

/** Wraps a value as an MCP text result. Compact JSON — this is read by an LLM, not a human, and indentation is pure token overhead across 124 tools' worth of responses. */
export function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
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
