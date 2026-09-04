# Known limitations

Cloudflare-side restrictions that **no token permission change can fix**. All three were
confirmed live against an account-owned token holding every relevant permission group.

`cf_check_permissions` reports these under `blocked_needs_manual_action`, and any direct
tool call surfaces the same explanation in its error — so you get the real fix, not a
misleading "add this permission group" suggestion.

---

## R2 requires a one-time account activation

**Affects:** every R2 tool (buckets and objects).

**Error:**
```
[10042] Please enable R2 through the Cloudflare Dashboard.
```

**Fix:** dash.cloudflare.com → **R2** (left sidebar) → accept the terms once.

This is an account-level switch, not a permission. It was confirmed independent of the
token entirely: while R2 is off, the S3-compatible endpoint
(`https://{account_id}.r2.cloudflarestorage.com`) does not even complete a TLS handshake,
so the separate R2 access key/secret can't reach it either.

---

## Page Rules rejects account-owned tokens

**Affects:** `cf_list_page_rules`, `cf_create_page_rule`, `cf_update_page_rule`,
`cf_delete_page_rule`.

**Error:**
```
[1011] Page Rules endpoint does not support account owned tokens.
```

**Fix (recommended):** use **Single Redirects** instead — `cf_create_redirect`,
`cf_list_redirects`, `cf_delete_redirect`. This is Cloudflare's modern replacement for
Page Rules and works fine on account-owned tokens.

**Fix (if you truly need legacy Page Rules):** create a separate **user-owned** token
under your profile icon → My Profile → API Tokens. Account-owned tokens can never call
this endpoint, at any permission level.

Note that Page Rules are also quota-limited by zone plan (3 on Free, 20 on Pro, 50 on
Business, 125 on Enterprise), which is another reason to prefer Single Redirects.

---

## Legacy Zone Analytics rejects account-owned tokens

**Affects:** `cf_zone_analytics`.

**Error:**
```
[1016] Zone Analytics API only supports authentication using user-owned credentials.
If you need to use an Account-Owned Token, please migrate to the replacement API: GraphQL API
```

**Fix:** use `cf_graphql_query` or `cf_dns_analytics` instead. Both are confirmed working
on account-owned tokens and return the same underlying data. `cf_graphql_query` is the
broadest analytics surface Cloudflare offers — it covers HTTP requests, firewall events,
Workers invocations, R2, and more.

The legacy `/analytics/dashboard` endpoint is also Enterprise-gated on many plans, so
`cf_graphql_query` is the better default regardless of token type.

---

## Summary

**119 of 124 tools** work end-to-end on an account-owned token with correctly scoped
permissions. The 5 that don't are listed above — and each has a working replacement
already included in the 119.

| Blocked tool | Use instead |
|---|---|
| `cf_list_page_rules` | `cf_list_redirects` |
| `cf_create_page_rule` | `cf_create_redirect` |
| `cf_update_page_rule` | `cf_delete_redirect` + `cf_create_redirect` |
| `cf_delete_page_rule` | `cf_delete_redirect` |
| `cf_zone_analytics` | `cf_graphql_query` or `cf_dns_analytics` |
