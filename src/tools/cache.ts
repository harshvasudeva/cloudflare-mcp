import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cfFetch, resolveZone, seg } from "../cloudflare.js";
import { textResult, requireConfirm, zoneParam } from "../util.js";

export function registerCacheTools(server: McpServer): void {
  server.registerTool(
    "cf_purge_cache",
    {
      title: "Purge Cloudflare cache",
      description:
        "Purge cached content for a zone. Pass exactly one of: everything=true, files[], tags[], hosts[], or prefixes[]. " +
        "Tag/host/prefix purging requires an Enterprise plan. Requires confirm=true.",
      inputSchema: {
        zone: zoneParam,
        everything: z.boolean().optional().describe("Purge the entire cache for the zone"),
        files: z.array(z.string()).optional().describe("Full URLs to purge"),
        tags: z.array(z.string()).optional().describe("Cache-Tag values to purge (Enterprise)"),
        hosts: z.array(z.string()).optional().describe("Hostnames to purge (Enterprise)"),
        prefixes: z.array(z.string()).optional().describe("URL prefixes to purge (Enterprise)"),
        confirm: z.boolean().describe("Must be true — purging affects live traffic"),
      },
    },
    async ({ zone, everything, files, tags, hosts, prefixes, confirm }) => {
      const modes = [
        everything ? "everything" : undefined,
        files ? "files" : undefined,
        tags ? "tags" : undefined,
        hosts ? "hosts" : undefined,
        prefixes ? "prefixes" : undefined,
      ].filter(Boolean);

      if (modes.length !== 1) {
        throw new Error(`Pass exactly one purge mode (everything/files/tags/hosts/prefixes); got ${modes.length}.`);
      }
      requireConfirm(confirm, `purge cache (${modes[0]})`);

      const z_ = await resolveZone(zone);
      const body = everything ? { purge_everything: true } : { files, tags, hosts, prefixes };
      const resp = await cfFetch(`/zones/${z_.id}/purge_cache`, { method: "POST", body });
      return textResult({ zone: z_.name, purged: modes[0], result: resp.result });
    }
  );

  server.registerTool(
    "cf_get_zone_settings",
    {
      title: "Get all zone settings",
      description:
        "Read every configurable setting for a zone (SSL mode, always-use-HTTPS, min TLS, security level, Brotli, HTTP/3, dev mode, and so on).",
      inputSchema: { zone: zoneParam },
    },
    async ({ zone }) => {
      const z_ = await resolveZone(zone);
      const resp = await cfFetch<Array<{ id: string; value: unknown; editable: boolean }>>(
        `/zones/${z_.id}/settings`
      );
      return textResult({
        zone: z_.name,
        settings: resp.result.map((s) => ({ id: s.id, value: s.value, editable: s.editable })),
      });
    }
  );

  server.registerTool(
    "cf_get_zone_setting",
    {
      title: "Get one zone setting",
      description: "Read a single zone setting by its id, e.g. 'ssl', 'always_use_https', 'min_tls_version'.",
      inputSchema: { zone: zoneParam, setting: z.string().describe("Setting id, e.g. ssl") },
    },
    async ({ zone, setting }) => {
      const z_ = await resolveZone(zone);
      const resp = await cfFetch(`/zones/${z_.id}/settings/${seg(setting)}`);
      return textResult({ zone: z_.name, setting: resp.result });
    }
  );

  server.registerTool(
    "cf_update_zone_setting",
    {
      title: "Update a zone setting",
      description:
        "Change a zone setting. Common ids: ssl ('off'|'flexible'|'full'|'strict'), always_use_https ('on'|'off'), " +
        "min_tls_version ('1.0'-'1.3'), security_level, brotli, http3, development_mode, automatic_https_rewrites, " +
        "opportunistic_encryption, tls_1_3, websockets, ipv6. Requires confirm=true.",
      inputSchema: {
        zone: zoneParam,
        setting: z.string().describe("Setting id, e.g. always_use_https"),
        value: z
          .string()
          .optional()
          .describe("New value for string settings — e.g. 'on', 'off', 'full', 'strict', '1.2'"),
        value_json: z
          .string()
          .optional()
          .describe(
            "JSON-encoded value, for settings that take a number, boolean, or object " +
              "(e.g. browser_cache_ttl -> '14400', minify -> '{\"css\":\"on\"}'). Use instead of `value`."
          ),
        confirm: z.boolean().describe("Must be true — this changes live zone behaviour"),
      },
    },
    async ({ zone, setting, value, value_json, confirm }) => {
      requireConfirm(confirm, `change zone setting "${setting}"`);
      if (value === undefined && value_json === undefined) {
        throw new Error("Provide either 'value' (scalar) or 'value_json' (JSON-encoded object).");
      }

      let parsed: unknown = value;
      if (value_json !== undefined) {
        try {
          parsed = JSON.parse(value_json);
        } catch (err) {
          throw new Error(`value_json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const z_ = await resolveZone(zone);
      const resp = await cfFetch(`/zones/${z_.id}/settings/${seg(setting)}`, {
        method: "PATCH",
        body: { value: parsed },
      });
      return textResult({ zone: z_.name, setting: resp.result });
    }
  );
}
