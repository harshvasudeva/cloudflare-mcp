import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cfFetch, resolveZone, getPhaseEntrypoint, seg } from "../cloudflare.js";
import { textResult, requireConfirm, compact, jsonObject, zoneParam } from "../util.js";

const PHASE_DOC =
  "Ruleset phase. Common values: http_request_firewall_custom (custom WAF rules), http_ratelimit (rate limiting), " +
  "http_request_dynamic_redirect (single redirects), http_request_transform (URL rewrites), " +
  "http_request_origin (origin rules), http_response_headers_transform, http_request_firewall_managed (managed WAF).";

export function registerFirewallTools(server: McpServer): void {
  server.registerTool(
    "cf_list_rulesets",
    {
      title: "List rulesets",
      description: "List all rulesets in a zone (WAF, rate limiting, redirects, transforms).",
      inputSchema: { zone: zoneParam },
    },
    async ({ zone }) => {
      const z_ = await resolveZone(zone);
      const resp = await cfFetch<Array<Record<string, unknown>>>(`/zones/${z_.id}/rulesets`);
      return textResult({
        zone: z_.name,
        rulesets: resp.result.map((r) => ({ id: r.id, name: r.name, phase: r.phase, kind: r.kind })),
      });
    }
  );

  server.registerTool(
    "cf_get_ruleset",
    {
      title: "Get a ruleset",
      description: "Get a ruleset and all of its rules, by ruleset id.",
      inputSchema: { zone: zoneParam, ruleset_id: z.string() },
    },
    async ({ zone, ruleset_id }) => {
      const z_ = await resolveZone(zone);
      const resp = await cfFetch(`/zones/${z_.id}/rulesets/${seg(ruleset_id)}`);
      return textResult(resp.result);
    }
  );

  server.registerTool(
    "cf_get_phase_ruleset",
    {
      title: "Get the entrypoint ruleset for a phase",
      description:
        "Get the zone's entrypoint ruleset for a given phase — this is where your custom rules for that phase live. " +
        "Returns ruleset: null if no rule has ever been added for this phase yet (Cloudflare only creates the " +
        "entrypoint on first use). " +
        PHASE_DOC,
      inputSchema: { zone: zoneParam, phase: z.string().describe(PHASE_DOC) },
    },
    async ({ zone, phase }) => {
      const z_ = await resolveZone(zone);
      const entry = await getPhaseEntrypoint(z_.id, phase);
      return textResult({ zone: z_.name, phase, ruleset: entry });
    }
  );

  server.registerTool(
    "cf_update_phase_ruleset",
    {
      title: "Replace the rules in a phase",
      description:
        "Replace the full rule list of a phase's entrypoint ruleset. Each rule looks like " +
        "{expression: '(ip.src eq 1.2.3.4)', action: 'block', description: '...'}. " +
        "This overwrites every existing rule in that phase, so read it first with cf_get_phase_ruleset. Requires confirm=true. " +
        PHASE_DOC,
      inputSchema: {
        zone: zoneParam,
        phase: z.string().describe(PHASE_DOC),
        rules: z.array(jsonObject()).describe("Full replacement list of rules"),
        confirm: z.boolean().describe("Must be true — this replaces all rules in the phase"),
      },
    },
    async ({ zone, phase, rules, confirm }) => {
      requireConfirm(confirm, `replace all rules in phase "${phase}"`);
      const z_ = await resolveZone(zone);
      const resp = await cfFetch(`/zones/${z_.id}/rulesets/phases/${seg(phase)}/entrypoint`, {
        method: "PUT",
        body: { rules },
      });
      return textResult({ zone: z_.name, phase, ruleset: resp.result });
    }
  );

  server.registerTool(
    "cf_add_ruleset_rule",
    {
      title: "Add a rule to a ruleset",
      description:
        "Append a single rule to an existing ruleset without touching the others. " +
        "Example: expression '(http.request.uri.path contains \"/admin\")', action 'block'. " +
        "Requires confirm=true — this immediately affects live traffic.",
      inputSchema: {
        zone: zoneParam,
        ruleset_id: z.string(),
        expression: z.string().describe("Cloudflare filter expression"),
        action: z
          .string()
          .describe("e.g. block, challenge, managed_challenge, js_challenge, allow, log, skip, redirect, rewrite"),
        description: z.string().optional(),
        action_parameters: jsonObject().optional().describe("Action-specific parameters"),
        enabled: z.boolean().optional().default(true),
        confirm: z.boolean().describe("Must be true — this immediately affects live traffic"),
      },
    },
    async ({ zone, ruleset_id, expression, action, description, action_parameters, enabled, confirm }) => {
      requireConfirm(confirm, `add a "${action}" rule to ruleset ${ruleset_id}`);
      const z_ = await resolveZone(zone);
      const resp = await cfFetch(`/zones/${z_.id}/rulesets/${seg(ruleset_id)}/rules`, {
        method: "POST",
        body: compact({ expression, action, description, action_parameters, enabled }),
      });
      return textResult({ zone: z_.name, ruleset_id, result: resp.result });
    }
  );

  server.registerTool(
    "cf_update_ruleset_rule",
    {
      title: "Update a rule in a ruleset",
      description:
        "Patch a single rule inside a ruleset. Cloudflare's rule-update endpoint replaces the whole rule rather " +
        "than merging, so this reads the existing rule first and merges your fields over it before sending. " +
        "Requires confirm=true.",
      inputSchema: {
        zone: zoneParam,
        ruleset_id: z.string(),
        rule_id: z.string(),
        expression: z.string().optional(),
        action: z.string().optional(),
        description: z.string().optional(),
        action_parameters: jsonObject().optional(),
        enabled: z.boolean().optional(),
        confirm: z.boolean().describe("Must be true — this immediately affects live traffic"),
      },
    },
    async ({ zone, ruleset_id, rule_id, confirm, ...rest }) => {
      requireConfirm(confirm, `update rule ${rule_id} in ruleset ${ruleset_id}`);
      const z_ = await resolveZone(zone);
      const patch = compact(rest);
      if (Object.keys(patch).length === 0) throw new Error("Provide at least one field to update.");

      const rulesetResp = await cfFetch<{ rules?: Array<Record<string, unknown>> }>(
        `/zones/${z_.id}/rulesets/${seg(ruleset_id)}`
      );
      const existing = rulesetResp.result.rules?.find((r) => r.id === rule_id);
      if (!existing) {
        throw new Error(`No rule ${rule_id} found in ruleset ${ruleset_id}.`);
      }

      // Cloudflare requires the full rule body on update, not a merge — send
      // the existing rule's fields with the caller's overrides applied on top.
      const merged = {
        expression: patch.expression ?? existing.expression,
        action: patch.action ?? existing.action,
        description: patch.description ?? existing.description,
        action_parameters: patch.action_parameters ?? existing.action_parameters,
        enabled: patch.enabled ?? existing.enabled,
      };

      const resp = await cfFetch(`/zones/${z_.id}/rulesets/${seg(ruleset_id)}/rules/${seg(rule_id)}`, {
        method: "PATCH",
        body: compact(merged),
      });
      return textResult({ zone: z_.name, ruleset_id, rule_id, result: resp.result });
    }
  );

  server.registerTool(
    "cf_delete_ruleset_rule",
    {
      title: "Delete a rule from a ruleset",
      description: "Remove a single rule from a ruleset. Requires confirm=true.",
      inputSchema: {
        zone: zoneParam,
        ruleset_id: z.string(),
        rule_id: z.string(),
        confirm: z.boolean().describe("Must be true to actually delete"),
      },
    },
    async ({ zone, ruleset_id, rule_id, confirm }) => {
      requireConfirm(confirm, `delete rule ${rule_id}`);
      const z_ = await resolveZone(zone);
      await cfFetch(`/zones/${z_.id}/rulesets/${seg(ruleset_id)}/rules/${seg(rule_id)}`, { method: "DELETE" });
      return textResult({ zone: z_.name, deletedRule: rule_id });
    }
  );

  // --- IP access rules -----------------------------------------------------

  server.registerTool(
    "cf_list_access_rules",
    {
      title: "List IP access rules",
      description: "List IP / ASN / country access rules (block, challenge, allowlist) for a zone.",
      inputSchema: {
        zone: zoneParam,
        mode: z.enum(["block", "challenge", "whitelist", "js_challenge", "managed_challenge"]).optional(),
        page: z.number().int().positive().optional().default(1),
        per_page: z.number().int().positive().max(100).optional().default(50),
      },
    },
    async ({ zone, mode, page, per_page }) => {
      const z_ = await resolveZone(zone);
      const resp = await cfFetch(`/zones/${z_.id}/firewall/access_rules/rules`, {
        query: { mode, page, per_page },
      });
      return textResult({ zone: z_.name, rules: resp.result, result_info: resp.result_info });
    }
  );

  server.registerTool(
    "cf_create_access_rule",
    {
      title: "Create an IP access rule",
      description:
        "Block, challenge, or allowlist traffic by IP, IP range, ASN, or country. " +
        "target is one of: ip, ip_range, asn, country. Example: target 'ip', value '1.2.3.4', mode 'block'. " +
        "Requires confirm=true — this immediately affects live traffic.",
      inputSchema: {
        zone: zoneParam,
        target: z.enum(["ip", "ip_range", "asn", "country"]),
        value: z.string().describe("The IP, CIDR, AS number (e.g. AS13335), or 2-letter country code"),
        mode: z.enum(["block", "challenge", "whitelist", "js_challenge", "managed_challenge"]),
        notes: z.string().optional(),
        confirm: z.boolean().describe("Must be true — this immediately affects live traffic"),
      },
    },
    async ({ zone, target, value, mode, notes, confirm }) => {
      requireConfirm(confirm, `create a ${mode} access rule for ${target} "${value}"`);
      const z_ = await resolveZone(zone);
      const resp = await cfFetch(`/zones/${z_.id}/firewall/access_rules/rules`, {
        method: "POST",
        body: compact({ configuration: { target, value }, mode, notes }),
      });
      return textResult({ zone: z_.name, rule: resp.result });
    }
  );

  server.registerTool(
    "cf_delete_access_rule",
    {
      title: "Delete an IP access rule",
      description: "Remove an IP access rule from a zone. Requires confirm=true.",
      inputSchema: {
        zone: zoneParam,
        rule_id: z.string(),
        confirm: z.boolean().describe("Must be true to actually delete"),
      },
    },
    async ({ zone, rule_id, confirm }) => {
      requireConfirm(confirm, `delete IP access rule ${rule_id}`);
      const z_ = await resolveZone(zone);
      await cfFetch(`/zones/${z_.id}/firewall/access_rules/rules/${seg(rule_id)}`, { method: "DELETE" });
      return textResult({ zone: z_.name, deletedRule: rule_id });
    }
  );
}
