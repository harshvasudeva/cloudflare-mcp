# API token setup

The single most error-prone part of using this server. Read the gotcha section — it
cost real trial-and-error to pin down, and the symptom is deeply misleading.

## Quick check

After setting any token, run `cf_check_permissions`. It probes one endpoint per product
area and splits what's blocked into two buckets:

- **`blocked_needs_permission`** — add the named permission group to the token and retry.
- **`blocked_needs_manual_action`** — adding permissions will **not** help. Each entry
  carries a `fix` field with the actual action required. See [LIMITATIONS.md](LIMITATIONS.md).

Every tool call gets the same treatment, not just the diagnostic — a real 403/400 from
any tool names either the missing permission group or, for the known non-scope cases,
the actual fix.

## Creating the token

**dash.cloudflare.com → API Tokens → Create Token → Start from scratch.**

You need **two separate policy rows**, each with a different scope:

### Row 1 — scope "Entire Account"

| Permission group | Level |
|---|---|
| Workers Scripts | Edit |
| Workers KV Storage | Edit |
| Workers R2 Storage | Edit |
| D1 | Edit |
| Queues | Edit |
| Cloudflare Pages | Edit |
| Account Settings | Read |
| Account Analytics | Read |
| Logs | Edit |

### Row 2 — scope "All Domains" (or specific zones)

| Permission group | Level |
|---|---|
| Zone | Read |
| DNS | Edit |
| Zone Settings | Edit |
| Cache Purge | Purge |
| Zone WAF | Edit |
| Firewall Services | Edit |
| Zone Analytics | Read |
| Workers Routes | Edit |
| Dynamic Redirect | Edit |

Put the resulting token in `.env` as `CF_API_TOKEN`.

---

## ⚠️ The scope-row gotcha

Cloudflare's token UI has **two families of permission groups that share the same display
names**, depending on which scope the policy row is set to:

- Under scope **"Entire Account"**, a group like "DNS" means *account-level* DNS features
  (Registrar, DNS Firewall lists, DNS Views) — **not** actual DNS records.
- Under scope **"All Domains"** (or a specific zone), the same category shows the real
  *zone-level* groups governing `/zones/{id}/dns_records`, zone settings, firewall access
  rules, zone analytics, worker routes, and redirects.

Checking every box under an "Entire Account" row — even hitting the "Read & Write" bulk
toggle and seeing every category read "X/X" — grants **zero** zone-level permissions. You
must add a **second** policy row and explicitly switch its scope dropdown to **"All
Domains"**. One account-scope row is never enough, no matter how much of it is checked.

### Symptom

`cf_check_permissions` shows `workers` / `kv` / `d1` / `queues` / `pages` as available
(those are genuinely account-scoped, so row 1 covered them) while `dns`, `zone_settings`,
`firewall access rules`, `redirects`, `worker routes`, and `zone analytics dashboard` all
fail with `[10000] Authentication error` — even though the token looks fully permissioned
in the dashboard.

### Second gotcha, inside the zone row

The "Read & Write" bulk toggle at the top of a policy row may only apply to permission
categories you have actually **expanded/viewed**, not silently apply to collapsed ones.

If some zone-level areas still 403 after adding the zone row, manually expand each
category — App Security, Analytics & Logs, Network Services, Rules & Configuration,
DNS & Zones — verify the checkboxes actually stuck, then re-save.

---

## Account-owned vs user-owned tokens

Tokens created under **Manage Account → API Tokens** are *account-owned*. Tokens created
under **your profile icon → My Profile → API Tokens** are *user-owned*.

Almost everything works with either. Two legacy endpoints reject account-owned tokens
outright at any permission level — see [LIMITATIONS.md](LIMITATIONS.md). Both have modern
replacements already included in this server, so an account-owned token is fine for
normal use.

## R2 credentials

R2 object operations run over the S3-compatible API, not Cloudflare's REST API. Set
`R2_ACCESS_KEY_ID` in `.env` (a non-secret token id, from **dash.cloudflare.com → R2 →
Manage API Tokens**):

- **Key id only** → the server mints short-lived scoped S3 credentials per bucket via
  `/r2/temp-access-credentials`. That endpoint requires `parentAccessKeyId`, which is why
  the key id is needed even on this path.
- **Key id + `R2_SECRET_ACCESS_KEY`** → the server signs directly with the static keys,
  skipping the per-request mint call.

Optionally set `R2_S3_ENDPOINT` if Cloudflare gave you a jurisdiction-specific endpoint;
otherwise it defaults to `https://{account_id}.r2.cloudflarestorage.com`.

**R2 also needs a one-time account activation** in the dashboard before any R2 tool works
— see [LIMITATIONS.md](LIMITATIONS.md).
