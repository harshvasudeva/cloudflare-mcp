# Safety model

This server hands an AI agent write access to live infrastructure. The guardrails below
are the reason that's reasonable rather than reckless.

## The `confirm: true` gate

Every tool that creates, deletes, overwrites, or otherwise affects live traffic or data declares
`confirm` as a **required** boolean in its input schema. Because it's required rather than
optional, the MCP protocol layer itself rejects the call before the handler even runs —
a stronger guarantee than a runtime check alone.

### Gated tools

**Deletes** — every one, without exception:
`cf_delete_dns_record`, `cf_delete_worker`, `cf_delete_worker_secret`,
`cf_delete_worker_route`, `cf_detach_worker_domain`, `cf_delete_r2_bucket`,
`cf_delete_r2_object`, `cf_remove_r2_custom_domain`, `cf_delete_kv_namespace`,
`cf_delete_kv_value`, `cf_delete_d1_database`, `cf_delete_queue`,
`cf_delete_queue_consumer`, `cf_delete_pages_project`, `cf_delete_pages_deployment`,
`cf_remove_pages_domain`, `cf_delete_ruleset_rule`, `cf_delete_access_rule`,
`cf_delete_page_rule`, `cf_delete_redirect`, `cf_delete_logpush_job`

**Overwrites and live-traffic changes:**
`cf_deploy_worker`, `cf_update_worker_settings`, `cf_create_worker_deployment`,
`cf_update_worker_schedules`, `cf_put_worker_secret`, `cf_create_worker_route`,
`cf_update_worker_route`, `cf_attach_worker_domain`, `cf_update_dns_record`,
`cf_put_kv_value`, `cf_bulk_put_kv`, `cf_put_r2_object`, `cf_copy_r2_object`,
`cf_put_r2_cors`, `cf_put_r2_lifecycle`, `cf_set_r2_public_access`,
`cf_add_r2_custom_domain`, `cf_put_r2_event_notification`, `cf_purge_cache`,
`cf_update_zone_setting`, `cf_update_phase_ruleset`, `cf_add_ruleset_rule`,
`cf_update_ruleset_rule`, `cf_create_access_rule`, `cf_update_pages_project`,
`cf_create_logpush_job`, `cf_queue_ack` (when acknowledging), and D1 writes.

**Creates and other live actions:**
`cf_create_kv_namespace`, `cf_rename_kv_namespace`, `cf_create_d1_database`,
`cf_create_queue`, `cf_update_queue`, `cf_create_queue_consumer`, `cf_queue_push`,
`cf_queue_pull`, `cf_create_r2_bucket`, `cf_create_pages_project`,
`cf_retry_pages_deployment`, `cf_add_pages_domain`, `cf_add_dns_record`,
`cf_create_page_rule`, `cf_update_page_rule`, and `cf_create_redirect`.

Read/list/get tools and the short-lived Worker log-tail session are ungated.

## D1 SQL gating

`cf_d1_query` can't rely on the API for safety — D1's `/query` endpoint has no read-only
mode and executes `;`-separated statements in a single call. The gate is therefore a
deliberately conservative heuristic:

- Only a **single, plain `SELECT` or `EXPLAIN`** statement runs without `confirm`.
- Multi-statement input always requires `confirm`, regardless of what the first keyword
  is — this closes the `SELECT 1; DROP TABLE users` bypass.
- `WITH` and `PRAGMA` always require `confirm`, since a CTE can wrap a write and some
  PRAGMAs mutate session state.

This is a guardrail, not a guarantee. Treat `cf_d1_query` as a write tool.

## Ruleset update semantics

`cf_update_ruleset_rule` reads the existing rule and merges your fields over it before
sending. Cloudflare's rule-update endpoint **replaces** the whole rule rather than
merging — per their docs, *"You must include all the rule fields that you want to be part
of the new rule definition, even if you are not changing their values."* Sending a bare
`{enabled: false}` would otherwise be rejected or wipe the rule's other fields.

## Credentials

- `.env` holds a live API token and R2 S3 credentials. It is gitignored and must stay
  that way — never commit it, never paste it into chat or an issue.
- The token typically reaches **every zone on the account**, not just `CF_ZONE`. Pass
  `zone` explicitly when you mean a specific one.
- Prefer the narrowest token that covers what you actually use. `cf_check_permissions`
  tells you exactly what's reachable, so it's easy to verify a scoped-down token still
  does the job.

## Reducing blast radius

Set `CF_MODULES` to register only the modules you need — a server that never registers
`cf_delete_worker` cannot be talked into calling it:

```json
{ "env": { "CF_MODULES": "dns,kv" } }
```
