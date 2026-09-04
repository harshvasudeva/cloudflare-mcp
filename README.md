# cloudflare-mcp

A local [MCP](https://modelcontextprotocol.io) server that lets any MCP-capable AI client
— Claude, Codex, Antigravity — manage your Cloudflare account: DNS, Workers, R2, KV, D1,
Queues, Pages, cache, WAF/firewall, rules, and analytics.

**124 tools.** Every destructive one gated behind an explicit `confirm: true`.
**119 verified end-to-end** against a live account.

```
"add an A record for staging pointing at 1.2.3.4"
"deploy this worker with a KV binding"
"what's in my R2 bucket?"
"block that ASN at the firewall"
"purge the cache for /assets/*"
```

---

## Features

| Area | Tools | Highlights |
|---|---|---|
| **DNS** | 5 | Full CRUD, all record types (A/AAAA/CNAME/TXT/MX/SRV/CAA/…), multi-zone, proxied toggle, structured `data` for SRV/CAA |
| **Workers** | 23 | Real code deploys (multipart), all 16 binding types, secrets, cron triggers, routes, custom domains, versions, gradual rollouts, rollback, tail logs |
| **R2 — buckets** | 15 | Bucket CRUD, CORS, lifecycle, public `r2.dev` toggle, custom domains, event notifications |
| **R2 — objects** | 7 | Real file ops over the S3 API — list, upload, download, copy, head, delete, presigned URLs |
| **KV** | 10 | Namespace CRUD, key read/write/delete, bulk writes, TTL, metadata |
| **D1** | 7 | Database CRUD, parameterised SQL, table listing, export |
| **Queues** | 11 | Queue CRUD, consumers, push/pull/ack |
| **Pages** | 14 | Project CRUD, deployments, retry, rollback, build logs, custom domains |
| **Cache & zone settings** | 4 | Purge (everything/files/tags/hosts/prefixes), read + write every zone setting |
| **WAF, firewall & rules** | 17 | Custom WAF rulesets, rate limiting, IP/ASN/country access rules, Single Redirects, Page Rules |
| **Analytics & logs** | 6 | GraphQL analytics, DNS analytics, Logpush job management |
| **Diagnostics** | 5 | `cf_check_permissions` tells you exactly what your token can and can't reach, and why |

Plus quality-of-life throughout:

- **Name *or* ID everywhere** — `zone: "example.com"` or a zone id; `namespace: "sessions"`
  or a namespace id. Resolved and cached transparently.
- **Sensible defaults** — omit `zone`/`account` and it uses `CF_ZONE`/`CF_ACCOUNT_ID`.
- **Actionable errors** — a 403 names the exact permission group to add; a Cloudflare-side
  restriction that no permission can fix says so, and names the tool to use instead.
- **Trimmable** — `CF_MODULES=dns,workers` registers a slimmer server for clients that
  degrade with long tool lists.

---

## Quick start

```bash
npm install
npm run build
```

Create a `.env` beside the project:

```ini
CF_API_TOKEN=your-token-here
CF_ACCOUNT_ID=your-account-id
CF_ZONE=example.com

# Only needed for R2 object operations
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
```

> ⚠️ The API token needs **two policy rows with different scopes** — an account-scoped one
> and a zone-scoped one. Granting everything under a single "Entire Account" row silently
> gives you **zero** DNS/zone-settings/firewall permissions. This is the single most common
> setup failure: **[docs/TOKEN_SETUP.md](docs/TOKEN_SETUP.md)**.

Then register it with your client:

**Claude Code** (user scope, works from any directory):
```bash
claude mcp add --scope user cloudflare -- node /path/to/cloudflare-mcp/dist/index.js
```

**Codex CLI** — `~/.codex/config.toml`:
```toml
[mcp_servers.cloudflare]
command = "node"
args = ["/path/to/cloudflare-mcp/dist/index.js"]
```

**Antigravity / Claude Desktop** — MCP settings:
```json
{
  "mcpServers": {
    "cloudflare": {
      "command": "node",
      "args": ["/path/to/cloudflare-mcp/dist/index.js"]
    }
  }
}
```

Finally, run **`cf_check_permissions`** — it probes every product area and tells you what's
reachable, what needs a permission group added, and what needs a manual dashboard step.

> Rebuild after changing `src/`: `npm run build`. A running MCP client holds the old build
> in memory, so **restart/reconnect the client** to pick it up.

---

## Documentation

| Doc | What's in it |
|---|---|
| **[Token setup](docs/TOKEN_SETUP.md)** | The two-policy-row requirement, the scope gotcha that silently grants nothing, R2 credentials |
| **[Known limitations](docs/LIMITATIONS.md)** | R2 activation, and the two legacy endpoints that reject account-owned tokens — with their modern replacements |
| **[Safety model](docs/SAFETY.md)** | What `confirm: true` covers, D1 SQL gating, ruleset merge semantics, reducing blast radius |
| **[Testing](docs/TESTING.md)** | What's verified live, bugs live testing caught, how to drive the server over stdio |
| **[Architecture](docs/ARCHITECTURE.md)** | Code layout, the shared client, adding a tool module, conventions, env vars |

---

## Tool reference

<details>
<summary><b>Zones &amp; diagnostics</b> (5)</summary>

`cf_verify_token` · `cf_check_permissions` · `cf_list_zones` · `cf_get_zone` ·
`cf_list_accounts`
</details>

<details>
<summary><b>DNS</b> (5)</summary>

`cf_list_dns_records` · `cf_get_dns_record` · `cf_add_dns_record` ·
`cf_update_dns_record` · `cf_delete_dns_record`
</details>

<details>
<summary><b>Workers</b> (23)</summary>

`cf_list_workers` · `cf_get_worker` · `cf_get_worker_code` · `cf_deploy_worker` ·
`cf_delete_worker` · `cf_update_worker_settings` · `cf_list_worker_versions` ·
`cf_list_worker_deployments` · `cf_create_worker_deployment` · `cf_list_worker_secrets` ·
`cf_put_worker_secret` · `cf_delete_worker_secret` · `cf_get_worker_schedules` ·
`cf_update_worker_schedules` · `cf_list_worker_routes` · `cf_create_worker_route` ·
`cf_update_worker_route` · `cf_delete_worker_route` · `cf_list_worker_domains` ·
`cf_attach_worker_domain` · `cf_detach_worker_domain` · `cf_get_workers_subdomain` ·
`cf_tail_worker`

`cf_deploy_worker` uploads real code and supports every binding type: `plain_text`,
`secret_text`, `kv_namespace`, `r2_bucket`, `d1`, `queue`, `service`,
`durable_object_namespace`, `analytics_engine`, `hyperdrive`, `vectorize`,
`mtls_certificate`, `ai`, `browser_rendering`, `assets`, `version_metadata`.
</details>

<details>
<summary><b>R2</b> (22)</summary>

**Buckets:** `cf_list_r2_buckets` · `cf_create_r2_bucket` · `cf_get_r2_bucket` ·
`cf_delete_r2_bucket` · `cf_get_r2_cors` · `cf_put_r2_cors` · `cf_get_r2_lifecycle` ·
`cf_put_r2_lifecycle` · `cf_get_r2_public_access` · `cf_set_r2_public_access` ·
`cf_list_r2_custom_domains` · `cf_add_r2_custom_domain` · `cf_remove_r2_custom_domain` ·
`cf_get_r2_event_notifications` · `cf_put_r2_event_notification`

**Objects:** `cf_list_r2_objects` · `cf_get_r2_object` · `cf_put_r2_object` ·
`cf_delete_r2_object` · `cf_copy_r2_object` · `cf_head_r2_object` · `cf_presign_r2_url`

Object operations run over the S3-compatible API (they aren't in Cloudflare's REST API).
Cross-bucket copies do a read+write, since a temp credential is scoped to one bucket.
</details>

<details>
<summary><b>KV</b> (10)</summary>

`cf_list_kv_namespaces` · `cf_create_kv_namespace` · `cf_rename_kv_namespace` ·
`cf_delete_kv_namespace` · `cf_list_kv_keys` · `cf_get_kv_value` · `cf_get_kv_metadata` ·
`cf_put_kv_value` · `cf_bulk_put_kv` · `cf_delete_kv_value`
</details>

<details>
<summary><b>D1</b> (7)</summary>

`cf_list_d1_databases` · `cf_create_d1_database` · `cf_get_d1_database` ·
`cf_delete_d1_database` · `cf_d1_query` · `cf_d1_list_tables` · `cf_d1_export`

Only a single plain `SELECT`/`EXPLAIN` runs freely — multi-statement input, `WITH`,
`PRAGMA`, and writes all require `confirm: true`. See [SAFETY.md](docs/SAFETY.md).
</details>

<details>
<summary><b>Queues</b> (11)</summary>

`cf_list_queues` · `cf_create_queue` · `cf_get_queue` · `cf_update_queue` ·
`cf_delete_queue` · `cf_list_queue_consumers` · `cf_create_queue_consumer` ·
`cf_delete_queue_consumer` · `cf_queue_push` · `cf_queue_pull` · `cf_queue_ack`
</details>

<details>
<summary><b>Pages</b> (14)</summary>

`cf_list_pages_projects` · `cf_get_pages_project` · `cf_create_pages_project` ·
`cf_update_pages_project` · `cf_delete_pages_project` · `cf_list_pages_deployments` ·
`cf_get_pages_deployment` · `cf_get_pages_deployment_logs` · `cf_retry_pages_deployment` ·
`cf_rollback_pages_deployment` · `cf_delete_pages_deployment` · `cf_list_pages_domains` ·
`cf_add_pages_domain` · `cf_remove_pages_domain`
</details>

<details>
<summary><b>Cache &amp; zone settings</b> (4)</summary>

`cf_purge_cache` · `cf_get_zone_settings` · `cf_get_zone_setting` ·
`cf_update_zone_setting`
</details>

<details>
<summary><b>WAF, firewall &amp; rules</b> (17)</summary>

`cf_list_rulesets` · `cf_get_ruleset` · `cf_get_phase_ruleset` ·
`cf_update_phase_ruleset` · `cf_add_ruleset_rule` · `cf_update_ruleset_rule` ·
`cf_delete_ruleset_rule` · `cf_list_access_rules` · `cf_create_access_rule` ·
`cf_delete_access_rule` · `cf_list_page_rules` · `cf_create_page_rule` ·
`cf_update_page_rule` · `cf_delete_page_rule` · `cf_list_redirects` ·
`cf_create_redirect` · `cf_delete_redirect`

Page Rules are legacy and reject account-owned tokens — use Single Redirects
(`cf_create_redirect`). See [LIMITATIONS.md](docs/LIMITATIONS.md).
</details>

<details>
<summary><b>Analytics &amp; logs</b> (6)</summary>

`cf_zone_analytics` · `cf_dns_analytics` · `cf_graphql_query` · `cf_list_logpush_jobs` ·
`cf_create_logpush_job` · `cf_delete_logpush_job`

`cf_graphql_query` is the broadest analytics surface and the recommended default.
</details>

---

## Trimming the tool list

124 tools is a lot, and some clients pick tools worse as the list grows. Set `CF_MODULES`
to a comma-separated subset:

```json
{ "env": { "CF_MODULES": "dns,workers,r2" } }
```

Valid modules: `dns`, `workers`, `r2`, `r2-objects`, `kv`, `d1`, `queues`, `pages`,
`cache`, `firewall`, `rules`, `analytics`. Zone/account tools (including
`cf_check_permissions`) are always registered. Unset = everything.

This also narrows blast radius — a server that never registers `cf_delete_worker` can't be
talked into calling it.

---

## Not included

Cloudflare's API also covers, if you want to extend it: Durable Objects, Vectorize,
Hyperdrive, Workers AI, AI Gateway, Workflows, Stream, Images, Zero Trust/Access, Tunnels,
Gateway, Turnstile, Waiting Room, Page Shield, API Shield, Load Balancing, Spectrum, Magic
Transit/WAN, certificates & custom hostnames, Email Routing, Registrar, audit logs,
members/roles, and billing.

Each is additive and follows the same `registerXTools` pattern — see
[ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Origin

Started as `cf.ps1` (still in the repo), an 88-line PowerShell script that did DNS record
CRUD against one hardcoded zone. This is that idea taken seriously.
