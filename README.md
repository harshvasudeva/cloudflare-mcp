# cloudflare-mcp

A local MCP server that lets any MCP-capable AI client (Claude, Codex, Antigravity, …)
manage Cloudflare: DNS, Workers, R2, KV, D1, Queues, Pages, cache, WAF/firewall, rules,
and analytics.

**124 tools**, all destructive ones gated behind an explicit `confirm: true`.

Replaces the original `cf.ps1` script (still present, untouched), which only did DNS CRUD.

---

## Setup

```bash
npm install
npm run build
```

That produces `dist/index.js`, a stdio MCP server. It reads `CF_API_TOKEN`,
`CF_ACCOUNT_ID`, and `CF_ZONE` from the environment, falling back to `.env` in this
folder for anything not already set — so you don't have to duplicate the token into
every client config.

Rebuild after any change to `src/`: `npm run build`.

### Registration

Already registered globally for Claude Code (user scope, so it works from any directory):

```bash
claude mcp add --scope user cloudflare -- node D:/code/cloudflare/dist/index.js
```

For **Codex CLI**, add to `~/.codex/config.toml`:

```toml
[mcp_servers.cloudflare]
command = "node"
args = ["D:\\code\\cloudflare\\dist\\index.js"]
```

For **Antigravity**, add via its MCP settings (same JSON shape as Claude Desktop):

```json
{
  "mcpServers": {
    "cloudflare": {
      "command": "node",
      "args": ["D:\\code\\cloudflare\\dist\\index.js"]
    }
  }
}
```

### Trimming the tool list

124 tools is a lot, and some clients pick tools worse as the list grows. Set
`CF_MODULES` to a comma-separated subset to register a slimmer server:

```json
{
  "mcpServers": {
    "cloudflare": {
      "command": "node",
      "args": ["D:\\code\\cloudflare\\dist\\index.js"],
      "env": { "CF_MODULES": "dns,workers,r2" }
    }
  }
}
```

Valid modules: `dns`, `workers`, `r2`, `r2-objects`, `kv`, `d1`, `queues`, `pages`,
`cache`, `firewall`, `rules`, `analytics`. Zone/account tools (including
`cf_check_permissions`) are always registered. Unset = everything.

---

## The API token

**Start here after setup, and after any token change:** run `cf_check_permissions`. It
probes one endpoint per product area and splits what's blocked into two buckets:

- **`blocked_needs_permission`** — add the named permission group to the token and retry.
- **`blocked_needs_manual_action`** — adding permissions will **not** help; each entry's
  `fix` field says what to actually do (a dashboard activation step, or a Cloudflare-side
  restriction with a different tool to use instead). See **Known limitations** below.

Every tool call gets the same treatment, not just the diagnostic — a real 403/400 from
any tool names either the missing permission group or, for the known non-scope cases,
the actual fix.

### Creating the token

Go to **dash.cloudflare.com → API Tokens → Create Token → Start from scratch**, then add
permission rows. **You need two separate policy rows, each with a different scope** —
this is the part that's easy to get wrong (see the gotcha below):

**Row 1 — scope "Entire Account":**
Workers Scripts:Edit, Workers KV Storage:Edit, Workers R2 Storage:Edit, D1:Edit,
Queues:Edit, Cloudflare Pages:Edit, Account Settings:Read, Account Analytics:Read,
Logs:Edit (account-level Logpush/Logs group)

**Row 2 — scope "All Domains" (or specific zones):**
Zone:Read, DNS:Edit, Zone Settings:Edit, Cache Purge:Purge, Zone WAF:Edit,
Firewall Services:Edit, Zone Analytics:Read, Workers Routes:Edit, Dynamic Redirect:Edit

Put the resulting token in `.env` as `CF_API_TOKEN`.

> #### ⚠️ The scope-row gotcha (this took real trial and error to nail down)
>
> Cloudflare's token UI has **two families of permission groups that share the same
> display names** depending on which scope a policy row is set to:
>
> - Under scope **"Entire Account"**, a group like "DNS" means *account-level* DNS
>   features (Registrar, DNS Firewall lists, DNS Views) — **not** actual DNS records.
> - Under scope **"All Domains"** (or a specific zone), the same category shows the real
>   *zone-level* groups that govern `/zones/{id}/dns_records`, zone settings, firewall
>   access rules, zone analytics, worker routes, and redirects.
>
> Checking every box under an "Entire Account" row — even hitting "Read & Write" and
> seeing every category read "X/X" — grants **zero** of the zone-level permissions your
> DNS/Settings/Firewall/Analytics/Routes/Redirects tools need. You must add a **second**
> policy row, explicitly switch its scope dropdown to **"All Domains"**, and grant the
> permissions again there. One account-scope row is not enough no matter how much of it
> you check.
>
> Symptom if you hit this: `cf_check_permissions` shows `workers`/`kv`/`d1`/`queues`/
> `pages` as available (genuinely account-scoped, so the first row was enough) while
> `dns`/`zone_settings`/`firewall access rules`/`redirects`/`worker routes`/`zone
> analytics dashboard` all 403 with `[10000] Authentication error` — even though the
> token "looks" fully permissioned in the dashboard.
>
> Also: within the zone-scoped row, the "Read & Write" bulk toggle at the top may only
> apply to permission categories you've actually expanded/viewed, not silently apply to
> every collapsed category. If some zone-level areas still 403 after adding the row,
> manually expand each category (App Security, Analytics & Logs, Network Services,
> Rules & Configuration, DNS & Zones) and verify the checkboxes actually stuck before
> re-saving.

---

## Tools

Every zone-level tool takes an optional `zone` (name or ID, defaulting to `CF_ZONE`);
every account-level tool takes an optional `account` (defaulting to `CF_ACCOUNT_ID`, else
the first visible account).

### Zones & diagnostics
`cf_verify_token`, `cf_check_permissions`, `cf_list_zones`, `cf_get_zone`, `cf_list_accounts`

### DNS
`cf_list_dns_records`, `cf_get_dns_record`, `cf_add_dns_record`, `cf_update_dns_record`,
`cf_delete_dns_record`

### Workers
`cf_list_workers`, `cf_get_worker`, `cf_get_worker_code`, `cf_deploy_worker`,
`cf_delete_worker`, `cf_update_worker_settings`, `cf_list_worker_versions`,
`cf_list_worker_deployments`, `cf_create_worker_deployment`, `cf_list_worker_secrets`,
`cf_put_worker_secret`, `cf_delete_worker_secret`, `cf_get_worker_schedules`,
`cf_update_worker_schedules`, `cf_list_worker_routes`, `cf_create_worker_route`,
`cf_update_worker_route`, `cf_delete_worker_route`, `cf_list_worker_domains`,
`cf_attach_worker_domain`, `cf_detach_worker_domain`, `cf_get_workers_subdomain`,
`cf_tail_worker`

`cf_deploy_worker` uploads real code (multipart with a JSON metadata part) and supports
the full binding set: `plain_text`, `secret_text`, `kv_namespace`, `r2_bucket`, `d1`,
`queue`, `service`, `durable_object_namespace`, `analytics_engine`, `hyperdrive`,
`vectorize`, `mtls_certificate`, `ai`, `browser_rendering`, `assets`, `version_metadata`.

### R2 — buckets
`cf_list_r2_buckets`, `cf_create_r2_bucket`, `cf_get_r2_bucket`, `cf_delete_r2_bucket`,
`cf_get_r2_cors`, `cf_put_r2_cors`, `cf_get_r2_lifecycle`, `cf_put_r2_lifecycle`,
`cf_get_r2_public_access`, `cf_set_r2_public_access`, `cf_list_r2_custom_domains`,
`cf_add_r2_custom_domain`, `cf_remove_r2_custom_domain`,
`cf_get_r2_event_notifications`, `cf_put_r2_event_notification`

### R2 — objects (files)
`cf_list_r2_objects`, `cf_get_r2_object`, `cf_put_r2_object`, `cf_delete_r2_object`,
`cf_copy_r2_object`, `cf_head_r2_object`, `cf_presign_r2_url`

R2 object operations aren't in Cloudflare's REST API — they run over the S3-compatible
endpoint. Set `R2_ACCESS_KEY_ID` in `.env` either way (it's a non-secret token id, from
an R2 API token at dash.cloudflare.com → R2 → Manage API Tokens):

- **Key id only** → the server mints short-lived scoped S3 credentials per bucket via
  `/r2/temp-access-credentials` (confirmed to require `parentAccessKeyId` in the request).
- **Key id + `R2_SECRET_ACCESS_KEY`** → the server signs directly with those static keys,
  skipping the per-request mint call.

Also note: **R2 needs a one-time activation** in the dashboard (R2 tab → accept terms)
before any R2 tool works, regardless of token permissions — a `[10042]` error from
`cf_check_permissions` means this step hasn't been done yet, not a permission problem.

`cf_copy_r2_object` between two different buckets does a read+write instead of a
native server-side copy, because a temp credential is scoped to one bucket and can't
read a different source bucket.

### KV
`cf_list_kv_namespaces`, `cf_create_kv_namespace`, `cf_rename_kv_namespace`,
`cf_delete_kv_namespace`, `cf_list_kv_keys`, `cf_get_kv_value`, `cf_get_kv_metadata`,
`cf_put_kv_value`, `cf_bulk_put_kv`, `cf_delete_kv_value`

### D1
`cf_list_d1_databases`, `cf_create_d1_database`, `cf_get_d1_database`,
`cf_delete_d1_database`, `cf_d1_query`, `cf_d1_list_tables`, `cf_d1_export`

`cf_d1_query` runs parameterised SQL. Only a single plain `SELECT`/`EXPLAIN` statement
runs freely; multi-statement input, `WITH`, `PRAGMA`, and anything that writes requires
`confirm: true` — D1 has no read-only mode, so this is a heuristic gate, not a guarantee.

### Queues
`cf_list_queues`, `cf_create_queue`, `cf_get_queue`, `cf_update_queue`, `cf_delete_queue`,
`cf_list_queue_consumers`, `cf_create_queue_consumer`, `cf_delete_queue_consumer`,
`cf_queue_push`, `cf_queue_pull`, `cf_queue_ack`

### Pages
`cf_list_pages_projects`, `cf_get_pages_project`, `cf_create_pages_project`,
`cf_update_pages_project`, `cf_delete_pages_project`, `cf_list_pages_deployments`,
`cf_get_pages_deployment`, `cf_get_pages_deployment_logs`, `cf_retry_pages_deployment`,
`cf_rollback_pages_deployment`, `cf_delete_pages_deployment`, `cf_list_pages_domains`,
`cf_add_pages_domain`, `cf_remove_pages_domain`

### Cache & zone settings
`cf_purge_cache`, `cf_get_zone_settings`, `cf_get_zone_setting`, `cf_update_zone_setting`

### WAF, firewall & rules
`cf_list_rulesets`, `cf_get_ruleset`, `cf_get_phase_ruleset`, `cf_update_phase_ruleset`,
`cf_add_ruleset_rule`, `cf_update_ruleset_rule`, `cf_delete_ruleset_rule`,
`cf_list_access_rules`, `cf_create_access_rule`, `cf_delete_access_rule`,
`cf_list_page_rules`, `cf_create_page_rule`, `cf_update_page_rule`, `cf_delete_page_rule`,
`cf_list_redirects`, `cf_create_redirect`, `cf_delete_redirect`

### Analytics & logs
`cf_zone_analytics`, `cf_dns_analytics`, `cf_graphql_query`, `cf_list_logpush_jobs`,
`cf_create_logpush_job`, `cf_delete_logpush_job`

`cf_graphql_query` is the most broadly available analytics surface — see **Known
limitations** for why `cf_zone_analytics` specifically may not work for you.

---

## Known limitations (Cloudflare-side — no token change fixes these)

Confirmed live against an **account-owned token** (created under Manage Account → API
Tokens, or the "all zones" flow most people end up using) with every relevant
permission group granted. These are Cloudflare rejecting the token *type*, not missing
scope — `cf_check_permissions` reports them under `blocked_needs_manual_action`, and any
direct tool call surfaces the same explanation.

| Area | What Cloudflare says | Fix |
|---|---|---|
| **R2** (all R2 tools) | `[10042] Please enable R2 through the Cloudflare Dashboard` | One-time: dash.cloudflare.com → **R2** (left sidebar) → accept terms. Not a permission — confirmed the S3-compatible endpoint doesn't even complete a TLS handshake until this is done, independent of the token entirely. |
| **Page Rules** (`cf_list_page_rules`, `cf_create_page_rule`, `cf_update_page_rule`, `cf_delete_page_rule`) | `[1011] Page Rules endpoint does not support account owned tokens` | Use `cf_create_redirect`/`cf_list_redirects`/`cf_delete_redirect` (Single Redirects) instead — the modern replacement, fully supported. If you specifically need legacy Page Rules, create a separate **user-owned** token under your profile icon → My Profile → API Tokens; account-owned tokens can never use this endpoint, at any permission level. |
| **Legacy Zone Analytics dashboard** (`cf_zone_analytics`) | `[1016] Zone Analytics API only supports authentication using user-owned credentials... migrate to GraphQL API` | Use `cf_graphql_query` or `cf_dns_analytics` instead — both confirmed working, same underlying data, fully supported on account-owned tokens. |

If you're on a **user-owned** token (My Profile → API Tokens) instead of account-owned,
Page Rules and legacy Analytics should work too — this project just wasn't tested against
one, since account-owned is what most people reach for first via "Manage Account."

---

## What's actually been verified

Not just "should work" — round-tripped live against a real account and cleaned up after
itself (create → verify → delete, or an equivalent safe no-op for things like zone
settings):

- **DNS** — add, get, update, delete
- **Zone Settings** — read + write (a no-op write, confirming the path works without
  changing live behavior)
- **IP Access Rules** — create (block a reserved TEST-NET-1 address, never real traffic),
  list, delete
- **Worker Routes** — create (inert pattern, no script attached), list, delete
- **WAF custom rules** — create phase ruleset on first use, add rule, get, delete rule
- **Workers** — deploy, list, update settings (via the multipart fix), secrets
  (put/list/delete), cron schedules (set/get/clear), delete
- **R2** — create bucket, put object, list objects, get object (content verified
  byte-for-byte), delete object, delete bucket
- **KV** — create namespace, put/get key, delete namespace
- **D1** — create database, DDL, parameterised insert, select, delete database
- **Queues** — create, delete
- **Pages** — create project, list, delete
- **DNS Analytics / GraphQL Analytics** — both return real data

**119 of 124 tools** are confirmed reachable end-to-end on an account-owned token with
correctly scoped permissions. The remaining 5 (`cf_list_page_rules`,
`cf_create_page_rule`, `cf_update_page_rule`, `cf_delete_page_rule`, `cf_zone_analytics`)
are the account-owned-token rejections above — each has a working modern-replacement
tool that *is* in the 119.

---

## Testing without a client

```bash
npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list
npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/call --tool-name cf_check_permissions
```

Note the inspector CLI does not forward your shell environment to the server, so
`CF_MODULES` has no effect there. It works normally under real MCP clients, which pass
`env` from their config.

---

## Safety

- Every tool that deletes, overwrites, or otherwise affects live traffic/data requires
  `confirm: true` — this covers all deletes, plus writes like `cf_put_kv_value`,
  `cf_put_r2_object`/`cf_copy_r2_object`, `cf_put_worker_secret`, `cf_update_dns_record`,
  `cf_deploy_worker`, `cf_purge_cache`, `cf_update_zone_setting`,
  `cf_create_worker_deployment`, `cf_attach_worker_domain`, `cf_create_worker_route`/
  `cf_update_worker_route`, `cf_add_ruleset_rule`/`cf_update_ruleset_rule`,
  `cf_create_access_rule`, `cf_create_logpush_job`, `cf_update_pages_project`,
  `cf_queue_ack` (when acknowledging), ruleset replacements, and D1 writes.
- `cf_update_ruleset_rule` reads the existing rule and merges your fields over it before
  sending — Cloudflare's update endpoint replaces the whole rule rather than merging, so
  a bare `{enabled: false}` would otherwise get rejected or wipe the rule's other fields.
- `.env` holds a live API token (and R2/S3 credentials) and is gitignored. Don't paste
  it into chat or commits.
- The token reaches every zone on the account, not just `CF_ZONE` — pass `zone`
  explicitly to target a specific one.

## Not included

Cloudflare's API also covers, if you want any of it later: Durable Objects, Vectorize,
Hyperdrive, Workers AI, AI Gateway, Workflows, Stream, Images, Zero Trust/Access,
Tunnels, Gateway, Turnstile, Waiting Room, Page Shield, API Shield, Load Balancing,
Spectrum, Magic Transit/WAN, certificates & custom hostnames, Email Routing, Registrar,
audit logs, members/roles, and billing. Each is additive and follows the same
`registerXTools` pattern in `src/tools/`.
