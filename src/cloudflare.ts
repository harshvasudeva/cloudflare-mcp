import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Fall back to reading .env next to the project (source of truth for the old
// cf.ps1 script) for any var the MCP host didn't already inject via its own
// server config. Host-provided env always wins.
function loadDotEnvFallback(): void {
  const envPath = join(__dirname, "..", ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = line.match(/^\s*([^=]+)=(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnvFallback();

export const CF_API_TOKEN = process.env.CF_API_TOKEN;
export const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
export const CF_DEFAULT_ZONE = process.env.CF_ZONE;

if (!CF_API_TOKEN) {
  throw new Error(
    "CF_API_TOKEN is not set. Provide it via the MCP client's env config or a .env file next to this project."
  );
}

export const API_BASE = "https://api.cloudflare.com/client/v4";
export const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly errors?: Array<{ code: number; message: string }>,
    /** Structured actionable guidance, when known — see KNOWN_ERROR_GUIDANCE. */
    public readonly hint?: string
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

export type CfResponse<T> = {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: unknown[];
  result: T;
  result_info?: {
    page?: number;
    per_page?: number;
    count?: number;
    total_count?: number;
    total_pages?: number;
    cursor?: string; // cursor-paginated endpoints (KV key listing) use this instead of total_pages
  };
};

/**
 * Maps a request path to the API token permission group that governs it, so a
 * bare 403 turns into an actionable message. Ordered most-specific first.
 */
const PERMISSION_HINTS: Array<[RegExp, string]> = [
  [/\/workers\/(scripts|domains|subdomain|services)/, "Workers Scripts:Edit"],
  [/\/workers\/routes/, "Workers Routes:Edit"],
  [/\/storage\/kv\//, "Workers KV Storage:Edit"],
  [/\/r2\//, "Workers R2 Storage:Edit"],
  [/\/event_notifications\/r2\//, "Workers R2 Storage:Edit"],
  [/\/d1\//, "D1:Edit"],
  [/\/queues/, "Queues:Edit"],
  [/\/pages\/projects/, "Cloudflare Pages:Edit"],
  [/\/purge_cache/, "Cache Purge:Purge"],
  [/\/settings/, "Zone Settings:Edit"],
  [/\/pagerules/, "Page Rules:Edit"],
  [/\/rulesets/, "Zone WAF:Edit (or Dynamic Redirect:Edit for redirect phases)"],
  [/\/firewall\//, "Firewall Services:Edit"],
  [/\/dns_analytics|\/analytics\//, "Zone Analytics:Read / Account Analytics:Read"],
  [/\/logpush\//, "Logs:Edit"],
  [/\/dns_records/, "DNS:Edit"],
  [/^\/accounts\/[^/]+$/, "Account Settings:Read"],
  [/^\/zones/, "Zone:Read"],
];

function permissionHint(path: string): string | undefined {
  for (const [pattern, group] of PERMISSION_HINTS) {
    if (pattern.test(path)) return group;
  }
  return undefined;
}

/**
 * Cloudflare error codes that mean "no permission grant on this token will
 * ever fix this" — confirmed live against an account-owned token with every
 * relevant permission group granted. These take priority over the generic
 * permission-group hint below, which would otherwise send the user in
 * circles editing token scope for something scope can't touch.
 */
const KNOWN_ERROR_GUIDANCE: Record<number, string> = {
  10042:
    "This is a one-time ACCOUNT-LEVEL ACTIVATION, not a token permission — no permission grant fixes it. " +
    "Go to dash.cloudflare.com → R2 (left sidebar) and accept its terms once, then retry.",
  1011:
    "Page Rules categorically rejects account-owned API tokens (Manage Account → API Tokens) — no permission " +
    "grant fixes this on this token. Use cf_list_redirects / cf_create_redirect (Single Redirects, the modern " +
    "replacement) instead, or create a separate user-owned token under My Profile → API Tokens if you " +
    "specifically need legacy Page Rules.",
  1016:
    "The legacy Zone Analytics dashboard categorically rejects account-owned API tokens — no permission grant " +
    "fixes this on this token. Use cf_graphql_query or cf_dns_analytics instead; both return the same data and " +
    "work fine with this token type.",
};

function buildError(path: string, status: number, errors?: Array<{ code: number; message: string }>): CloudflareApiError {
  const detail = errors?.map((e) => `[${e.code}] ${e.message}`).join("; ") || `HTTP ${status}`;

  const known = errors?.find((e) => e.code in KNOWN_ERROR_GUIDANCE);
  let hint: string | undefined;
  if (known) {
    hint = KNOWN_ERROR_GUIDANCE[known.code];
  } else {
    const isPermission = status === 403 || errors?.some((e) => e.code === 9109 || e.code === 10000);
    const group = isPermission ? permissionHint(path) : undefined;
    hint = group
      ? `This token appears to lack the "${group}" permission group. Add it at dash.cloudflare.com → ` +
        `My Profile → API Tokens → edit this token, then retry.`
      : undefined;
  }

  const message = `Cloudflare API error (HTTP ${status}) on ${path}: ${detail}${hint ? ` — ${hint}` : ""}`;
  return new CloudflareApiError(message, status, errors, hint);
}

export type CfFetchInit = {
  method?: string;
  /** JSON request body. Ignored when `form` is set. */
  body?: unknown;
  /** Multipart body; Content-Type is left unset so the boundary is generated. */
  form?: FormData;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
};

function buildRequest(path: string, init: CfFetchInit): { url: URL; options: RequestInit } {
  const url = new URL(`${API_BASE}${path}`);
  if (init.query) {
    for (const [key, value] of Object.entries(init.query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${CF_API_TOKEN}`,
    ...init.headers,
  };

  let body: BodyInit | undefined;
  if (init.form) {
    body = init.form; // fetch sets multipart/form-data + boundary itself
  } else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
  }

  return { url, options: { method: init.method ?? "GET", headers, body } };
}

/** Standard call returning Cloudflare's `{success, result}` envelope. */
export async function cfFetch<T = unknown>(path: string, init: CfFetchInit = {}): Promise<CfResponse<T>> {
  const { url, options } = buildRequest(path, init);
  const res = await fetch(url, options);

  const text = await res.text();

  // Some DELETE endpoints (confirmed: workers/domains) return HTTP 200/204 with
  // an empty body and no Content-Type. That's a success, not a parse failure.
  if (res.ok && text.trim() === "") {
    return { success: true, result: null as T, errors: [], messages: [] };
  }

  let json: CfResponse<T>;
  try {
    json = JSON.parse(text) as CfResponse<T>;
  } catch {
    throw new CloudflareApiError(
      `Cloudflare returned a non-JSON response (HTTP ${res.status}) on ${path}: ${text.slice(0, 300)}`,
      res.status
    );
  }

  if (!res.ok || !json.success) {
    throw buildError(path, res.status, json.errors);
  }
  return json;
}

/**
 * Call returning the raw response body. Used by endpoints that do not wrap
 * their payload in the standard envelope — worker script content, KV values.
 */
export async function cfFetchRaw(path: string, init: CfFetchInit = {}): Promise<string> {
  const { url, options } = buildRequest(path, init);
  const res = await fetch(url, options);
  const text = await res.text();

  if (!res.ok) {
    let errors: Array<{ code: number; message: string }> | undefined;
    try {
      errors = (JSON.parse(text) as CfResponse<unknown>).errors;
    } catch {
      /* body was not the JSON envelope; fall through with no structured errors */
    }
    throw buildError(path, res.status, errors);
  }
  return text;
}

/**
 * Follows `result_info.total_pages` and concatenates every page of a list endpoint.
 * Throws rather than silently truncating if an endpoint has more pages than
 * `maxPages` — a silent cap here previously caused resolvers to report
 * "no X named Y" for things that genuinely existed, just past page 20.
 */
export async function cfFetchAll<T = unknown>(
  path: string,
  init: CfFetchInit = {},
  perPage = 100,
  maxPages = 20
): Promise<T[]> {
  const out: T[] = [];
  let page = 1;
  for (;;) {
    const resp = await cfFetch<T[]>(path, { ...init, query: { ...init.query, page, per_page: perPage } });
    out.push(...(resp.result ?? []));
    const totalPages = resp.result_info?.total_pages ?? 1;
    if (page >= totalPages) break;
    if (page >= maxPages) {
      throw new Error(
        `cfFetchAll: hit the ${maxPages}-page cap on ${path} but there are ${totalPages} pages ` +
          `(${resp.result_info?.total_count ?? "unknown"} total items). Narrow the query with a filter.`
      );
    }
    page += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Generic name-or-id resolver
// ---------------------------------------------------------------------------

/**
 * Builds a memoized name→id resolver for account-scoped resources (KV
 * namespaces, D1 databases, Queues, ...). Consolidates what used to be three
 * near-identical copies in kv.ts/d1.ts/queues.ts, and fixes two bugs those
 * copies shared: the cache was never invalidated on rename/delete, and it
 * wasn't keyed by account, so two accounts with a same-named resource would
 * collide.
 *
 * `remember`/`forget` let create/rename/delete tools update the cache
 * directly, which also sidesteps a real issue hit in testing: calling a
 * fresh resource by name immediately after creating it can 500 on
 * Cloudflare's list endpoint (eventual consistency) — remembering the id at
 * creation time means that lookup never has to happen.
 */
export function makeNameResolver<T>(opts: {
  listPath: (account: string) => string;
  idOf: (item: T) => string;
  nameOf: (item: T) => string;
  idPattern: RegExp;
  label: string;
}) {
  const cache = new Map<string, string>(); // keyed by `${account}:${nameOrId}`

  async function resolve(account: string, nameOrId: string): Promise<string> {
    if (opts.idPattern.test(nameOrId)) return nameOrId;

    const cacheKey = `${account}:${nameOrId}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const all = await cfFetchAll<T>(opts.listPath(account));
    // Populate every item seen, not just the one asked for, so a later lookup
    // of a *different* name in the same account skips the list call entirely.
    let found: string | undefined;
    for (const item of all) {
      const id = opts.idOf(item);
      cache.set(`${account}:${opts.nameOf(item)}`, id);
      if (opts.nameOf(item) === nameOrId) found = id;
    }

    if (!found) {
      throw new Error(
        `No ${opts.label} named "${nameOrId}". Available: ${all.map(opts.nameOf).join(", ") || "(none)"}`
      );
    }
    return found;
  }

  return {
    resolve,
    remember(account: string, name: string, id: string): void {
      cache.set(`${account}:${name}`, id);
    },
    forget(account: string, name: string): void {
      cache.delete(`${account}:${name}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Zone + account resolution
// ---------------------------------------------------------------------------

export type ZoneRef = { id: string; name: string; status: string };

const zoneCache = new Map<string, ZoneRef>(); // keyed by both id and name
const HEX32 = /^[0-9a-f]{32}$/i;

/** Accepts a zone id, a zone name, or nothing (falls back to CF_ZONE). Returns {id, name, status}. */
export async function resolveZone(zoneNameOrId?: string): Promise<ZoneRef> {
  const target = zoneNameOrId ?? CF_DEFAULT_ZONE;
  if (!target) {
    throw new Error("No zone specified and CF_ZONE is not set as a default.");
  }

  const cached = zoneCache.get(target);
  if (cached) return cached;

  const zone = HEX32.test(target)
    ? await cfFetch<ZoneRef>(`/zones/${target}`).then((r) => r.result)
    : await cfFetch<Array<ZoneRef>>("/zones", { query: { name: target } }).then((r) => r.result[0]);

  if (!zone) {
    throw new Error(`No zone found for "${target}" (or token lacks access to it).`);
  }
  zoneCache.set(zone.id, zone);
  zoneCache.set(zone.name, zone);
  return zone;
}

let accountIdCache: string | undefined;

/** Prefers an explicit id, then CF_ACCOUNT_ID, then the first account the token can see. */
export async function resolveAccountId(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (CF_ACCOUNT_ID) return CF_ACCOUNT_ID;
  if (accountIdCache) return accountIdCache;

  const resp = await cfFetch<Array<{ id: string; name: string }>>("/accounts");
  if (!resp.result?.length) {
    throw new Error("No accounts visible to this token. Set CF_ACCOUNT_ID explicitly.");
  }
  accountIdCache = resp.result[0].id;
  return accountIdCache;
}

/**
 * Gets a zone's entrypoint ruleset for a phase. Cloudflare returns 404 until
 * the phase's entrypoint ruleset has been created at least once (e.g. a zone
 * with zero Single Redirects has no http_request_dynamic_redirect entrypoint
 * yet) — this returns null instead of throwing, so callers can distinguish
 * "nothing here yet" from a real error.
 */
export async function getPhaseEntrypoint(
  zoneId: string,
  phase: string
): Promise<{ id: string; rules: Array<Record<string, unknown>> } | null> {
  try {
    const resp = await cfFetch<{ id: string; rules?: Array<Record<string, unknown>> }>(
      `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`
    );
    return { id: resp.result.id, rules: resp.result.rules ?? [] };
  } catch (err) {
    if (err instanceof CloudflareApiError && err.status === 404) return null;
    throw err;
  }
}

/** Turns a short record name (or "@") into an FQDN using the given zone name. */
export function toFqdn(name: string | undefined, zoneName: string): string {
  if (!name || name === "@" || name === zoneName) return zoneName;
  if (name.endsWith(`.${zoneName}`)) return name;
  return `${name}.${zoneName}`;
}
