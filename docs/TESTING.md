# Testing & verification

## What's been verified live

Not "should work" — each of these was round-tripped against a real Cloudflare account and
cleaned up afterwards (create → verify → delete, or a safe no-op where a destructive test
wasn't appropriate).

| Area | Verified operations |
|---|---|
| **DNS** | add → get → update → delete |
| **Zone Settings** | read, plus a no-op write (set a setting to its current value) confirming the write path without changing live behavior |
| **IP Access Rules** | create (blocking a reserved TEST-NET-1 address, so it can never match real traffic) → list → delete |
| **Worker Routes** | create (inert pattern, no script attached) → list → delete |
| **WAF custom rules** | create phase ruleset on first use → add rule → get → delete rule |
| **Workers** | deploy → list → update settings (multipart) → secrets put/list/delete → cron schedules set/get/clear → delete |
| **R2** | create bucket → put object → list objects → get object (content verified byte-for-byte) → delete object → delete bucket |
| **KV** | create namespace → put key → get key → delete namespace |
| **D1** | create database → DDL → parameterised insert → select → delete database |
| **Queues** | create → delete |
| **Pages** | create project → list → delete |
| **Analytics** | `cf_dns_analytics` and `cf_graphql_query` both returned real data |

**119 of 124 tools** confirmed reachable end-to-end. The remaining 5 are the
account-owned-token rejections documented in [LIMITATIONS.md](LIMITATIONS.md).

## Bugs this testing caught

Live testing found real issues that static review alone did not:

- **D1 name resolution 500s immediately after creating a database.** Cloudflare's list
  endpoint hits an eventual-consistency gap seconds after creation. Fixed by having
  create/rename/delete tools populate the resolver cache directly, so a create-then-use
  flow never needs the list call.
- **Pages projects rejects `per_page` above 10.** Unlike every other list endpoint, the
  Pages projects endpoint 400s on anything but its default page size. Fixed by pinning
  `per_page=10` for that endpoint specifically.
- **`cf_check_permissions` conflated WAF and redirect permissions.** Listing rulesets and
  reading the redirect-phase entrypoint turned out to need *different* permission groups
  — a token could pass one and fail the other. Split into separate probes, with a probe
  for Workers Routes added too (also its own permission group).
- **Worker settings needs multipart, not JSON.** Confirmed against both official
  Cloudflare SDKs and then verified live.

## Testing without an MCP client

```bash
npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list
npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/call --tool-name cf_check_permissions
```

Two caveats with the inspector CLI:

- It does **not** forward your shell environment to the server, so `CF_MODULES` has no
  effect there. It works normally under real MCP clients, which pass `env` from config.
- It spawns a fresh process each run, which is actually useful: a long-running MCP client
  holds `dist/index.js` in memory, so **after `npm run build` you must restart/reconnect
  the client** to pick up changes. The inspector always runs the current build.

### Schema portability check

```bash
npx @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list --strict
```

Should report zero warnings. This matters for cross-client compatibility: stricter clients
(Gemini/Antigravity, some Codex validators) reject JSON Schema properties that carry no
validation keyword. That's why free-form object params use `jsonObject()` from
`src/util.ts` — which emits `{"type":"object","additionalProperties":true}` — rather than
`z.record(z.any())`, which emits a bare `{}`.

## Driving the server directly over stdio

For scripted end-to-end tests, speak MCP over stdio against a fresh process:

```js
import { spawn } from "node:child_process";

const p = spawn("node", ["dist/index.js"], { stdio: ["pipe", "pipe", "pipe"] });
const send = (m) => p.stdin.write(JSON.stringify(m) + "\n");

send({ jsonrpc: "2.0", id: 1, method: "initialize",
       params: { protocolVersion: "2024-11-05", capabilities: {},
                 clientInfo: { name: "probe", version: "1" } } });

// on the id:1 reply → send notifications/initialized, then:
send({ jsonrpc: "2.0", id: 2, method: "tools/call",
       params: { name: "cf_check_permissions", arguments: {} } });
```

This is how the verification table above was produced, and it's the reliable way to test
a build without restarting your editor's MCP connection.
