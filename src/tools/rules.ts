import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cfFetch, resolveZone, getPhaseEntrypoint, seg } from "../cloudflare.js";
import { textResult, requireConfirm, compact, jsonObject, zoneParam } from "../util.js";

const REDIRECT_PHASE = "http_request_dynamic_redirect";

export function registerRulesTools(server: McpServer): void {
  // --- Page Rules (legacy) -------------------------------------------------

  server.registerTool(
    "cf_list_page_rules",
    {
      title: "List Page Rules",
      description: "List legacy Page Rules for a zone.",
      inputSchema: { zone: zoneParam },
    },
    async ({ zone }) => {
      const z_ = await resolveZone(zone);
      const resp = await cfFetch(`/zones/${z_.id}/pagerules`);
      return textResult({ zone: z_.name, pageRules: resp.result });
    }
  );

  server.registerTool(
    "cf_create_page_rule",
    {
      title: "Create a Page Rule",
      description:
        "Create a legacy Page Rule. Requires confirm=true. targets is e.g. " +
        "[{target: 'url', constraint: {operator: 'matches', value: '*example.com/blog*'}}] and actions is e.g. " +
        "[{id: 'cache_level', value: 'cache_everything'}].",
      inputSchema: {
        zone: zoneParam,
        targets: z.array(jsonObject()).describe("URL match targets"),
        actions: z.array(jsonObject()).describe("Actions to apply"),
        priority: z.number().int().optional(),
        status: z.enum(["active", "disabled"]).optional().default("active"),
        confirm: z.boolean().describe("Must be true — this changes live zone behaviour"),
      },
    },
    async ({ zone, targets, actions, priority, status, confirm }) => {
      requireConfirm(confirm, "create a Page Rule");
      const z_ = await resolveZone(zone);
      const resp = await cfFetch(`/zones/${z_.id}/pagerules`, {
        method: "POST",
        body: compact({ targets, actions, priority, status }),
      });
      return textResult({ zone: z_.name, pageRule: resp.result });
    }
  );

  server.registerTool(
    "cf_update_page_rule",
    {
      title: "Update a Page Rule",
      description: "Patch an existing Page Rule's targets, actions, priority, or status. Requires confirm=true.",
      inputSchema: {
        zone: zoneParam,
        rule_id: z.string(),
        targets: z.array(jsonObject()).optional(),
        actions: z.array(jsonObject()).optional(),
        priority: z.number().int().optional(),
        status: z.enum(["active", "disabled"]).optional(),
        confirm: z.boolean().describe("Must be true — this changes live zone behaviour"),
      },
    },
    async ({ zone, rule_id, confirm, ...rest }) => {
      requireConfirm(confirm, `update Page Rule ${rule_id}`);
      const z_ = await resolveZone(zone);
      const patch = compact(rest);
      if (Object.keys(patch).length === 0) throw new Error("Provide at least one field to update.");
      const resp = await cfFetch(`/zones/${z_.id}/pagerules/${seg(rule_id)}`, { method: "PATCH", body: patch });
      return textResult({ zone: z_.name, pageRule: resp.result });
    }
  );

  server.registerTool(
    "cf_delete_page_rule",
    {
      title: "Delete a Page Rule",
      description: "Delete a legacy Page Rule. Requires confirm=true.",
      inputSchema: {
        zone: zoneParam,
        rule_id: z.string(),
        confirm: z.boolean().describe("Must be true to actually delete"),
      },
    },
    async ({ zone, rule_id, confirm }) => {
      requireConfirm(confirm, `delete Page Rule ${rule_id}`);
      const z_ = await resolveZone(zone);
      await cfFetch(`/zones/${z_.id}/pagerules/${seg(rule_id)}`, { method: "DELETE" });
      return textResult({ zone: z_.name, deletedPageRule: rule_id });
    }
  );

  // --- Single Redirects (modern rulesets) ----------------------------------

  server.registerTool(
    "cf_list_redirects",
    {
      title: "List single redirects",
      description: "List modern Single Redirect rules for a zone (the dynamic-redirect ruleset phase).",
      inputSchema: { zone: zoneParam },
    },
    async ({ zone }) => {
      const z_ = await resolveZone(zone);
      // Cloudflare 404s until a redirect has ever been added on this zone —
      // that's "no redirects", not an error.
      const entry = await getPhaseEntrypoint(z_.id, REDIRECT_PHASE);
      return textResult({ zone: z_.name, rulesetId: entry?.id ?? null, redirects: entry?.rules ?? [] });
    }
  );

  server.registerTool(
    "cf_create_redirect",
    {
      title: "Create a single redirect",
      description:
        "Add a URL redirect rule. Requires confirm=true. Give either a static target_url, or an expression + dynamic target expression. " +
        "Example: source_expression '(http.request.full_uri wildcard \"https://example.com/old/*\")', " +
        "target_url 'https://example.com/new', status 301.",
      inputSchema: {
        zone: zoneParam,
        source_expression: z.string().describe("Cloudflare expression matching requests to redirect"),
        target_url: z.string().describe("Destination URL, or an expression when dynamic=true"),
        status: z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]).optional().default(301),
        preserve_query_string: z.boolean().optional().default(true),
        dynamic: z
          .boolean()
          .optional()
          .default(false)
          .describe("Treat target_url as a Cloudflare expression rather than a literal URL"),
        description: z.string().optional(),
        confirm: z.boolean().describe("Must be true — this changes live request routing"),
      },
    },
    async ({ zone, source_expression, target_url, status, preserve_query_string, dynamic, description, confirm }) => {
      requireConfirm(confirm, "create a redirect rule");
      const z_ = await resolveZone(zone);
      const newRule = compact({
        expression: source_expression,
        action: "redirect",
        description,
        action_parameters: {
          from_value: {
            status_code: status,
            target_url: dynamic ? { expression: target_url } : { value: target_url },
            preserve_query_string,
          },
        },
      });

      const entry = await getPhaseEntrypoint(z_.id, REDIRECT_PHASE);
      const result = entry
        ? // Entrypoint already exists: append without touching other redirects.
          await cfFetch(`/zones/${z_.id}/rulesets/${entry.id}/rules`, { method: "POST", body: newRule })
        : // First redirect on this zone: PUT creates the entrypoint ruleset (documented upsert behavior).
          await cfFetch(`/zones/${z_.id}/rulesets/phases/${REDIRECT_PHASE}/entrypoint`, {
            method: "PUT",
            body: { rules: [newRule] },
          });
      return textResult({ zone: z_.name, redirect: result.result });
    }
  );

  server.registerTool(
    "cf_delete_redirect",
    {
      title: "Delete a single redirect",
      description: "Remove a Single Redirect rule by its rule id. Requires confirm=true.",
      inputSchema: {
        zone: zoneParam,
        rule_id: z.string().describe("Rule id from cf_list_redirects"),
        confirm: z.boolean().describe("Must be true to actually delete"),
      },
    },
    async ({ zone, rule_id, confirm }) => {
      requireConfirm(confirm, `delete redirect rule ${rule_id}`);
      const z_ = await resolveZone(zone);
      const entry = await getPhaseEntrypoint(z_.id, REDIRECT_PHASE);
      if (!entry) {
        throw new Error(`No redirects exist on zone "${z_.name}" — nothing to delete.`);
      }
      await cfFetch(`/zones/${z_.id}/rulesets/${entry.id}/rules/${seg(rule_id)}`, { method: "DELETE" });
      return textResult({ zone: z_.name, deletedRedirect: rule_id });
    }
  );
}
