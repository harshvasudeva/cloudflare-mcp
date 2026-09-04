import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cfFetch, cfFetchAll, resolveZone, resolveAccountId, CF_DEFAULT_ZONE, CloudflareApiError } from "../cloudflare.js";
import { textResult } from "../util.js";

export function registerZoneTools(server: McpServer): void {
  server.registerTool(
    "cf_verify_token",
    {
      title: "Verify Cloudflare API token",
      description:
        "Checks that the configured CF_API_TOKEN is valid and can see the default zone (CF_ZONE). Zone-scoped tokens often reject the generic /user/tokens/verify endpoint even when valid, so this does a zone lookup instead.",
      inputSchema: {},
    },
    async () => {
      if (!CF_DEFAULT_ZONE) {
        return textResult({ ok: false, reason: "CF_ZONE is not configured, cannot run the zone-lookup check." });
      }
      try {
        // Token checks must hit Cloudflare even after another tool has cached
        // this zone; otherwise a revoked token would keep reporting success.
        const zone = await resolveZone(CF_DEFAULT_ZONE, { bypassCache: true });
        return textResult({ ok: true, zone: zone.name, zoneId: zone.id, status: zone.status });
      } catch (err) {
        return textResult({ ok: false, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  server.registerTool(
    "cf_check_permissions",
    {
      title: "Check what this token can do",
      description:
        "Probes one representative endpoint per product area and reports which are reachable and which are blocked. " +
        "Blocked areas are split into two kinds: blocked_needs_permission (add the named permission group to the " +
        "token and retry) and blocked_needs_manual_action (adding permissions will NOT help — e.g. R2 needs a " +
        "one-time dashboard activation, and legacy Page Rules / Zone Analytics categorically reject account-owned " +
        "tokens; each entry's `fix` field says exactly what to do instead). Run this after changing the API token " +
        "to see exactly which tools will work.",
      inputSchema: {},
    },
    async () => {
      let account: string | undefined;
      let zoneId: string | undefined;

      try {
        account = await resolveAccountId();
      } catch {
        /* probes needing an account id will be reported as unavailable below */
      }
      try {
        zoneId = (await resolveZone()).id;
      } catch {
        /* same for zone-scoped probes */
      }

      // Note: general "rulesets" access (Zone WAF:Edit) and the redirect-phase
      // entrypoint (apparently gated by a separate Dynamic Redirect:Edit
      // permission) turned out NOT to be the same permission in testing — a
      // token that can list rulesets fine can still 403 on redirects. They
      // get separate probes below so this doesn't over-report.
      const probes: Array<{ area: string; path?: string; permission: string; treat404AsOk?: boolean }> = [
        { area: "zones", path: "/zones?per_page=1", permission: "Zone:Read" },
        { area: "dns", path: zoneId && `/zones/${zoneId}/dns_records?per_page=1`, permission: "DNS:Edit" },
        { area: "workers", path: account && `/accounts/${account}/workers/scripts`, permission: "Workers Scripts:Edit" },
        { area: "worker routes", path: zoneId && `/zones/${zoneId}/workers/routes`, permission: "Workers Routes:Edit" },
        { area: "r2", path: account && `/accounts/${account}/r2/buckets`, permission: "Workers R2 Storage:Edit" },
        { area: "kv", path: account && `/accounts/${account}/storage/kv/namespaces`, permission: "Workers KV Storage:Edit" },
        { area: "d1", path: account && `/accounts/${account}/d1/database`, permission: "D1:Edit" },
        { area: "queues", path: account && `/accounts/${account}/queues`, permission: "Queues:Edit" },
        { area: "pages", path: account && `/accounts/${account}/pages/projects`, permission: "Cloudflare Pages:Edit" },
        { area: "zone_settings", path: zoneId && `/zones/${zoneId}/settings`, permission: "Zone Settings:Edit" },
        { area: "rulesets (WAF)", path: zoneId && `/zones/${zoneId}/rulesets`, permission: "Zone WAF:Edit" },
        {
          area: "redirects",
          path: zoneId && `/zones/${zoneId}/rulesets/phases/http_request_dynamic_redirect/entrypoint`,
          permission: "Dynamic Redirect:Edit",
          treat404AsOk: true, // 404 means "no redirects created yet", not "no permission"
        },
        {
          area: "firewall access rules",
          path: zoneId && `/zones/${zoneId}/firewall/access_rules/rules?per_page=1`,
          permission: "Firewall Services:Edit",
        },
        {
          area: "page_rules (legacy)",
          path: zoneId && `/zones/${zoneId}/pagerules`,
          permission: "Page Rules:Edit",
        },
        {
          area: "zone analytics dashboard (legacy)",
          path: zoneId && `/zones/${zoneId}/analytics/dashboard`,
          permission: "Zone Analytics:Read",
        },
        { area: "logpush", path: zoneId && `/zones/${zoneId}/logpush/jobs`, permission: "Logs:Edit" },
      ];

      const results = await Promise.all(
        probes.map(async ({ area, path, permission, treat404AsOk }) => {
          if (!path) {
            return { area, available: false, permission, reason: "could not resolve account/zone for this probe" };
          }
          try {
            await cfFetch(path);
            return { area, available: true, permission };
          } catch (err) {
            if (treat404AsOk && err instanceof CloudflareApiError && err.status === 404) {
              return { area, available: true, permission };
            }
            if (err instanceof CloudflareApiError) {
              return {
                area,
                available: false,
                permission,
                reason: err.errors?.map((e) => `[${e.code}] ${e.message}`).join("; ") ?? err.message,
                // Present only when the block is NOT fixable by adding a permission group
                // (account-owned-token rejections, one-time dashboard activations, etc.) —
                // see KNOWN_ERROR_GUIDANCE in cloudflare.ts.
                fix: err.hint,
              };
            }
            return { area, available: false, permission, reason: String(err) };
          }
        })
      );

      const available = results.filter((r) => r.available).map((r) => r.area);
      const blocked = results.filter((r) => !r.available);
      // "fix" is only ever set for the special, non-scope-fixable cases (see above);
      // everything else genuinely just needs the permission group added.
      const needsMorePermissions = blocked.filter((b) => !("fix" in b) || !b.fix);
      const needsManualAction = blocked.filter((b) => "fix" in b && b.fix);

      return textResult({
        account: account ?? null,
        zone: zoneId ?? null,
        available,
        blocked_needs_permission: needsMorePermissions.map((b) => ({
          area: b.area,
          needs: b.permission,
          reason: b.reason,
        })),
        blocked_needs_manual_action: needsManualAction.map((b) => ({
          area: b.area,
          reason: b.reason,
          fix: "fix" in b ? b.fix : undefined,
        })),
        hint:
          needsMorePermissions.length || needsManualAction.length
            ? "blocked_needs_permission: add those permission groups to the token. " +
              "blocked_needs_manual_action: each entry's own `fix` field says what to do — " +
              "adding permissions will NOT help those."
            : "This token can reach every area this server supports.",
      });
    }
  );

  server.registerTool(
    "cf_list_zones",
    {
      title: "List Cloudflare zones",
      description: "List all zones visible to this API token.",
      inputSchema: {
        name: z.string().optional().describe("Filter by exact zone name"),
      },
    },
    async ({ name }) => {
      const zones = await cfFetchAll<Record<string, unknown>>("/zones", { query: { name } }, 50);
      return textResult({
        count: zones.length,
        zones: zones.map((z_) => ({
          id: z_.id,
          name: z_.name,
          status: z_.status,
          plan: (z_.plan as { name?: string } | undefined)?.name,
          name_servers: z_.name_servers,
        })),
      });
    }
  );

  server.registerTool(
    "cf_get_zone",
    {
      title: "Get Cloudflare zone details",
      description: "Get details for a single zone by name or ID.",
      inputSchema: {
        zone: z.string().describe("Zone name or zone ID"),
      },
    },
    async ({ zone }) => {
      const z_ = await resolveZone(zone);
      const resp = await cfFetch(`/zones/${z_.id}`);
      return textResult(resp.result);
    }
  );

  server.registerTool(
    "cf_list_accounts",
    {
      title: "List Cloudflare accounts",
      description: "List Cloudflare accounts visible to this API token.",
      inputSchema: {},
    },
    async () => {
      const resp = await cfFetch<Array<Record<string, unknown>>>("/accounts");
      return textResult({ accounts: resp.result });
    }
  );
}
