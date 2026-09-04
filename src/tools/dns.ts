import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cfFetch, resolveZone, toFqdn } from "../cloudflare.js";
import { textResult, requireConfirm, jsonObject, compact } from "../util.js";

type DnsRecord = {
  id: string;
  type: string;
  name: string;
  content?: string;
  ttl: number;
  proxied?: boolean;
  priority?: number;
  data?: unknown;
  comment?: string | null;
  tags?: string[];
};

const zoneParam = z
  .string()
  .optional()
  .describe("Zone name or zone ID. Defaults to CF_ZONE from server config if omitted.");

const recordTypeParam = z
  .string()
  .describe("DNS record type, e.g. A, AAAA, CNAME, TXT, MX, NS, SRV, CAA, PTR, etc.");

async function findRecordByTypeName(zoneId: string, type: string, fqdn: string): Promise<DnsRecord> {
  const resp = await cfFetch<DnsRecord[]>(`/zones/${zoneId}/dns_records`, {
    query: { type, name: fqdn },
  });
  if (resp.result.length === 0) {
    throw new Error(`No ${type} record found for "${fqdn}".`);
  }
  if (resp.result.length > 1) {
    throw new Error(
      `Found ${resp.result.length} ${type} records for "${fqdn}" — pass "id" explicitly to disambiguate. IDs: ${resp.result
        .map((r) => r.id)
        .join(", ")}`
    );
  }
  return resp.result[0];
}

export function registerDnsTools(server: McpServer): void {
  server.registerTool(
    "cf_list_dns_records",
    {
      title: "List Cloudflare DNS records",
      description: "List DNS records in a zone, optionally filtered by type and/or name.",
      inputSchema: {
        zone: zoneParam,
        type: z.string().optional().describe("Filter by record type, e.g. A"),
        name: z.string().optional().describe("Filter by exact record name/FQDN"),
        search: z.string().optional().describe("Filter by substring match on name or content"),
        page: z.number().int().positive().optional().default(1),
        per_page: z.number().int().positive().max(100).optional().default(50),
      },
    },
    async ({ zone, type, name, search, page, per_page }) => {
      const z_ = await resolveZone(zone);
      const resp = await cfFetch<DnsRecord[]>(`/zones/${z_.id}/dns_records`, {
        query: { type, name, search, page, per_page },
      });
      return textResult({ zone: z_.name, result_info: resp.result_info, records: resp.result });
    }
  );

  server.registerTool(
    "cf_get_dns_record",
    {
      title: "Get a Cloudflare DNS record",
      description: "Get a single DNS record by id, or by type+name if id is not known.",
      inputSchema: {
        zone: zoneParam,
        id: z.string().optional().describe("DNS record ID"),
        type: recordTypeParam.optional(),
        name: z.string().optional().describe("Record name, short name, or '@' for the zone apex"),
      },
    },
    async ({ zone, id, type, name }) => {
      const z_ = await resolveZone(zone);
      let record: DnsRecord;
      if (id) {
        record = (await cfFetch<DnsRecord>(`/zones/${z_.id}/dns_records/${id}`)).result;
      } else if (type && name) {
        record = await findRecordByTypeName(z_.id, type, toFqdn(name, z_.name));
      } else {
        throw new Error("Provide either 'id', or both 'type' and 'name'.");
      }
      return textResult({ zone: z_.name, record });
    }
  );

  server.registerTool(
    "cf_add_dns_record",
    {
      title: "Add a Cloudflare DNS record",
      description:
        "Create a new DNS record in a zone. For simple types (A, AAAA, CNAME, TXT, NS, PTR, MX) use 'content' (+ 'priority' for MX). For types that need structured data (SRV, CAA, etc.) pass 'data' matching the Cloudflare API shape for that type.",
      inputSchema: {
        zone: zoneParam,
        type: recordTypeParam,
        name: z.string().describe("Record name, short name, or '@' for the zone apex"),
        content: z.string().optional().describe("Record content, e.g. an IP address or hostname"),
        data: jsonObject().optional().describe("Structured record data for types like SRV/CAA"),
        ttl: z.number().int().optional().default(300).describe("TTL in seconds (1 = automatic)"),
        proxied: z.boolean().optional().default(false).describe("Proxy through Cloudflare (orange cloud)"),
        priority: z.number().int().optional().describe("Priority, used by MX/SRV records"),
        comment: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ zone, type, name, content, data, ttl, proxied, priority, comment, tags }) => {
      const z_ = await resolveZone(zone);
      const fqdn = toFqdn(name, z_.name);
      if (!content && !data) {
        throw new Error("Provide either 'content' or 'data'.");
      }
      const resp = await cfFetch<DnsRecord>(`/zones/${z_.id}/dns_records`, {
        method: "POST",
        body: { type, name: fqdn, content, data, ttl, proxied, priority, comment, tags },
      });
      return textResult({ zone: z_.name, created: resp.result });
    }
  );

  server.registerTool(
    "cf_update_dns_record",
    {
      title: "Update a Cloudflare DNS record",
      description:
        "Partially update an existing DNS record, identified by id or by type+name. Requires confirm=true — " +
        "this repoints a live record.",
      inputSchema: {
        zone: zoneParam,
        id: z.string().optional().describe("DNS record ID"),
        type: recordTypeParam.optional().describe("Required with 'name' if 'id' is not given"),
        name: z.string().optional().describe("Required with 'type' if 'id' is not given"),
        content: z.string().optional(),
        data: jsonObject().optional(),
        ttl: z.number().int().optional(),
        proxied: z.boolean().optional(),
        priority: z.number().int().optional(),
        comment: z.string().optional(),
        tags: z.array(z.string()).optional(),
        confirm: z.boolean().describe("Must be true — this repoints a live DNS record"),
      },
    },
    async ({ zone, id, type, name, content, data, ttl, proxied, priority, comment, tags, confirm }) => {
      requireConfirm(confirm, "update a DNS record");
      const z_ = await resolveZone(zone);
      let recordId = id;
      if (!recordId) {
        if (!type || !name) throw new Error("Provide either 'id', or both 'type' and 'name'.");
        recordId = (await findRecordByTypeName(z_.id, type, toFqdn(name, z_.name))).id;
      }
      const patch = compact({ content, data, ttl, proxied, priority, comment, tags });
      if (Object.keys(patch).length === 0) {
        throw new Error("Provide at least one field to update (content, data, ttl, proxied, priority, comment, tags).");
      }
      const resp = await cfFetch<DnsRecord>(`/zones/${z_.id}/dns_records/${recordId}`, {
        method: "PATCH",
        body: patch,
      });
      return textResult({ zone: z_.name, updated: resp.result });
    }
  );

  server.registerTool(
    "cf_delete_dns_record",
    {
      title: "Delete a Cloudflare DNS record",
      description:
        "Delete a DNS record, identified by id or by type+name. Requires confirm=true as a safety check.",
      inputSchema: {
        zone: zoneParam,
        id: z.string().optional().describe("DNS record ID"),
        type: recordTypeParam.optional().describe("Required with 'name' if 'id' is not given"),
        name: z.string().optional().describe("Required with 'type' if 'id' is not given"),
        confirm: z.boolean().describe("Must be explicitly set to true to actually delete the record"),
      },
    },
    async ({ zone, id, type, name, confirm }) => {
      requireConfirm(confirm, "delete a DNS record");
      const z_ = await resolveZone(zone);
      let recordId = id;
      let describedAs = id ?? "";
      if (!recordId) {
        if (!type || !name) throw new Error("Provide either 'id', or both 'type' and 'name'.");
        const fqdn = toFqdn(name, z_.name);
        const found = await findRecordByTypeName(z_.id, type, fqdn);
        recordId = found.id;
        describedAs = `${type} ${fqdn}`;
      }
      await cfFetch(`/zones/${z_.id}/dns_records/${recordId}`, { method: "DELETE" });
      return textResult({ zone: z_.name, deleted: recordId, describedAs });
    }
  );
}
