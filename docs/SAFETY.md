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

**Local filesystem writes:** `cf_get_r2_object` requires `confirm` only when `save_to`
is set — a plain inline read stays ungated, but streaming an R2 object to an arbitrary
local path is a write with real disk consequences and gets the same treatment as any
other write.

Read/list/get tools and the short-lived Worker log-tail session are ungated.

A regression test (`test/confirm-gating.test.mjs`) spawns the built server and checks,
for every tool whose description promises `confirm=true`, that the schema actually
requires it — this is the exact class of bug that's easy to introduce silently in a
124-tool codebase (a copy-pasted tool that forgets one field). Three tools are
documented exceptions where `confirm` is conditionally required by runtime logic
instead of the schema (`cf_d1_query`, `cf_get_r2_object`, `cf_queue_ack`) — the test
tracks them by name so a typo'd exception doesn't silently mask a real gap.

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

## Path segment encoding

Every tool argument that lands in a request *path* (worker names, bucket names,
ruleset/rule ids, project names, zone settings ids, ...) goes through `seg()` in
`cloudflare.ts` before interpolation. Without it, `new URL()` normalizes `../`
sequences in the finished path — a tool argument like `name: "../../../user/tokens"`
silently rewrote `/accounts/X/workers/scripts/{name}` into `/accounts/user/tokens`,
and a value like `"foo?per_page=999"` injected extra query parameters. Confirmed by
direct `new URL()` construction (see `test/path-traversal.test.mjs`), not theoretical —
this matters more than usual here because tool arguments are chosen by an LLM that may
be acting on untrusted content (a webpage, a document, a poisoned prompt), not typed by
a human who'd notice something was off.

Values that are already known-safe are exempt: Cloudflare-issued ids matched against a
strict hex/uuid pattern by `resolveZone`/`resolveAccountId`/`makeNameResolver`, and
values that go through `URLSearchParams` (query params encode automatically). R2 object
keys are exempt for a different reason — they go through the AWS S3 SDK's structured
`Bucket`/`Key` parameters, never raw string concatenation, so the SDK handles encoding
per the S3 spec.

`resolveAccountId`'s explicit `account` argument gets the same treatment via validation
rather than encoding: a real Cloudflare account id is always 32 hex characters, so
anything else is rejected outright rather than passed through to a path.

## Local file access (R2 upload/download)

`cf_put_r2_object`'s `file_path` and `cf_get_r2_object`'s `save_to` read and write
whatever local path they're given — that's the tool's actual job (uploading/downloading
files a user names), so it isn't sandboxed to a fixed directory, which would break
legitimate use ("upload D:\backups\report.pdf"). The mitigations that exist instead:

- Both require `confirm: true` (download only when `save_to` is actually set — a plain
  inline read stays ungated).
- Both tool descriptions explicitly warn against passing a path suggested by untrusted
  content.

Treat these two exactly like you'd treat "read/write an arbitrary file" in any other
tool: fine when the human is asking for it, dangerous if an agent derives the path from
content it doesn't control.

## Credential redaction

Logpush jobs echo `destination_conf` back verbatim from Cloudflare's API — for `r2://`,
`s3://`, or an HTTP destination with query-string auth, that string embeds a live access
key id, secret, or bearer token. `cf_list_logpush_jobs` and `cf_create_logpush_job` both
redact it before it enters the conversation, so a credential you configured once doesn't
resurface every time you list your jobs.

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
