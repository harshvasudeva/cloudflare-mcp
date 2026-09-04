# Architecture

A stdio MCP server in TypeScript. ~3,500 lines, no framework beyond the official MCP SDK.

```
src/
├── index.ts          Module registry + CF_MODULES toggle + stdio transport
├── cloudflare.ts     Shared REST client, resolvers, error mapping
├── util.ts           textResult, requireConfirm, compact, jsonObject
├── r2-client.ts      S3 client factory for R2 object operations
└── tools/
    ├── zones.ts      Zone + account reads, cf_verify_token, cf_check_permissions
    ├── dns.ts        DNS records
    ├── workers.ts    Scripts, secrets, crons, routes, domains, deployments
    ├── r2.ts         R2 buckets (REST)
    ├── r2-objects.ts R2 objects (S3 API)
    ├── kv.ts         KV namespaces + keys
    ├── d1.ts         D1 databases + SQL
    ├── queues.ts     Queues, consumers, messages
    ├── pages.ts      Pages projects + deployments
    ├── cache.ts      Cache purge + zone settings
    ├── firewall.ts   WAF rulesets + IP access rules
    ├── rules.ts      Page Rules + Single Redirects
    └── analytics.ts  Zone/DNS/GraphQL analytics + Logpush
```

## Adding a tool module

Each file exports one `registerXTools(server: McpServer)` that calls
`server.registerTool(name, config, handler)` per tool. Register it in the `MODULES` map in
`index.ts` and it's live — that map also drives the `CF_MODULES` env filter.

```ts
export function registerThingTools(server: McpServer): void {
  server.registerTool(
    "cf_list_things",
    {
      title: "List things",
      description: "...",
      inputSchema: { account: accountParam },
    },
    async ({ account }) => {
      const acct = await resolveAccountId(account);
      const things = await cfFetchAll(`/accounts/${acct}/things`);
      return textResult({ account: acct, things });
    }
  );
}
```

## The shared client (`cloudflare.ts`)

| Export | Purpose |
|---|---|
| `cfFetch<T>(path, init)` | Standard call returning Cloudflare's `{success, result}` envelope. Handles JSON and multipart bodies, and treats an empty successful body as success rather than a parse error. |
| `cfFetchRaw(path, init)` | For endpoints that return a bare body, not the envelope — worker script content, KV values. |
| `cfFetchAll<T>(path, init, perPage, maxPages)` | Follows `result_info.total_pages`. **Throws** rather than silently truncating when it hits the page cap. |
| `resolveZone(nameOrId?)` | Accepts a zone name, a zone id, or nothing (falls back to `CF_ZONE`). Cached. |
| `resolveAccountId(explicit?)` | Explicit id → `CF_ACCOUNT_ID` → first visible account. Cached. |
| `makeNameResolver<T>(opts)` | Builds a memoized name→id resolver for account-scoped resources. |
| `getPhaseEntrypoint(zoneId, phase)` | Returns `null` instead of throwing when a ruleset phase has no entrypoint yet. |
| `toFqdn(name, zoneName)` | Short record name or `@` → FQDN. |

### Error mapping

`buildError` turns a bare Cloudflare failure into something actionable:

1. If the response carries a code in `KNOWN_ERROR_GUIDANCE` (R2 not activated, Page Rules
   / Zone Analytics rejecting account-owned tokens), attach that specific guidance — these
   are **not** fixable by adding token scope, so the generic hint would mislead.
2. Otherwise, if it looks permission-shaped, map the request path to the API token
   permission group that governs it via the `PERMISSION_HINTS` table and say which group
   to add.

The guidance is exposed both in `error.message` and as a structured `error.hint`, which is
what `cf_check_permissions` uses to split `blocked_needs_permission` from
`blocked_needs_manual_action`.

### Name resolvers

KV namespaces, D1 databases, and Queues are all addressable by human name but the API
wants ids. `makeNameResolver` handles this once for all three, keyed by
`${account}:${name}` so two accounts with a same-named resource don't collide.

Create/rename/delete tools call `remember()`/`forget()` to keep the cache honest. That
also sidesteps a real Cloudflare quirk: listing a resource by name immediately after
creating it can 500 on eventual consistency, and remembering the id at creation time
means that lookup never has to happen.

## Conventions

- **Every zone-level tool** takes an optional `zone` (name or id, defaults to `CF_ZONE`).
- **Every account-level tool** takes an optional `account` (defaults to `CF_ACCOUNT_ID`).
- **Destructive/overwriting tools** declare `confirm` as a *required* boolean — see
  [SAFETY.md](SAFETY.md).
- **Free-form object params** use `jsonObject()` from `util.ts`, never `z.record(z.any())`
  — see the schema portability note in [TESTING.md](TESTING.md).
- **Responses** go through `textResult()`, which pretty-prints JSON into MCP text content.
- **Partial updates** build their body with `compact()` to drop `undefined` fields.

## Env

| Var | Required | Purpose |
|---|---|---|
| `CF_API_TOKEN` | yes | Cloudflare API token |
| `CF_ACCOUNT_ID` | no | Default account; else first visible |
| `CF_ZONE` | no | Default zone for zone-level tools |
| `R2_ACCESS_KEY_ID` | for R2 objects | R2 token id (also the required `parentAccessKeyId`) |
| `R2_SECRET_ACCESS_KEY` | no | Set to sign directly instead of minting temp credentials |
| `R2_S3_ENDPOINT` | no | Override the S3 endpoint (jurisdiction-specific buckets) |
| `CF_MODULES` | no | Comma-separated module subset; unset = all |

Read from the process environment first, falling back to `.env` beside the project for
anything not already set — so MCP client configs don't need to duplicate the token.
