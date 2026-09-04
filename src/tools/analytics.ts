import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cfFetch, resolveZone, CF_API_TOKEN, GRAPHQL_ENDPOINT } from "../cloudflare.js";
import { textResult, requireConfirm, compact, jsonObject, zoneParam } from "../util.js";

/**
 * Logpush jobs echo `destination_conf` back verbatim, which for r2://, s3://,
 * or an HTTP destination with query-string auth embeds an access key id,
 * secret, or bearer token directly in the string. Redacting before it enters
 * the conversation avoids putting live credentials into chat transcripts and
 * client-side logs.
 */
function redactJob(job: unknown): unknown {
  if (!job || typeof job !== "object") return job;
  const { destination_conf, ...rest } = job as Record<string, unknown>;
  return destination_conf === undefined
    ? rest
    : { ...rest, destination_conf: "[redacted — use cf_list_logpush_jobs' job_id to reference this job]" };
}

export function registerAnalyticsTools(server: McpServer): void {
  server.registerTool(
    "cf_zone_analytics",
    {
      title: "Get zone analytics",
      description:
        "Traffic analytics for a zone: requests, bandwidth, threats, page views, and cache hit ratio over a time window. " +
        "Note that the legacy dashboard endpoint is Enterprise-only on many plans — if it 403s, use cf_graphql_query instead.",
      inputSchema: {
        zone: zoneParam,
        since: z.string().optional().default("-1440").describe("Start: minutes back as a negative number, or an ISO timestamp"),
        until: z.string().optional().describe("End: minutes back as a negative number, or an ISO timestamp"),
        continuous: z.boolean().optional().default(true),
      },
    },
    async ({ zone, since, until, continuous }) => {
      const z_ = await resolveZone(zone);
      const resp = await cfFetch(`/zones/${z_.id}/analytics/dashboard`, {
        query: compact({ since, until, continuous }) as Record<string, string | boolean>,
      });
      return textResult({ zone: z_.name, analytics: resp.result });
    }
  );

  server.registerTool(
    "cf_dns_analytics",
    {
      title: "Get DNS analytics",
      description: "DNS query analytics for a zone — query counts broken down by the dimensions you request.",
      inputSchema: {
        zone: zoneParam,
        metrics: z.string().optional().default("queryCount").describe("Comma-separated metrics, e.g. queryCount,uncachedCount"),
        dimensions: z.string().optional().describe("Comma-separated dimensions, e.g. queryName,queryType,responseCode"),
        since: z.string().optional().describe("ISO timestamp or relative like -1440"),
        until: z.string().optional(),
        limit: z.number().int().positive().max(10000).optional().default(100),
      },
    },
    async ({ zone, metrics, dimensions, since, until, limit }) => {
      const z_ = await resolveZone(zone);
      const resp = await cfFetch(`/zones/${z_.id}/dns_analytics/report`, {
        query: compact({ metrics, dimensions, since, until, limit }) as Record<string, string | number>,
      });
      return textResult({ zone: z_.name, dnsAnalytics: resp.result });
    }
  );

  server.registerTool(
    "cf_graphql_query",
    {
      title: "Run a Cloudflare GraphQL analytics query",
      description:
        "Run an arbitrary query against Cloudflare's GraphQL Analytics API. This is the most flexible and " +
        "widely-available analytics surface — it covers HTTP requests, firewall events, Workers invocations, R2, and more. " +
        "Example query: 'query { viewer { zones(filter: {zoneTag: \"<id>\"}) { httpRequests1dGroups(limit: 7, " +
        "filter: {date_geq: \"2026-08-01\"}) { dimensions { date } sum { requests bytes } } } } }'",
      inputSchema: {
        query: z.string().describe("The GraphQL query string"),
        variables: jsonObject().optional().describe("Optional GraphQL variables object"),
      },
    },
    async ({ query, variables }) => {
      const res = await fetch(GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${CF_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
      const json = (await res.json()) as { data?: unknown; errors?: unknown };
      if (json.errors) {
        return textResult({ ok: false, errors: json.errors, data: json.data });
      }
      return textResult(json.data);
    }
  );

  server.registerTool(
    "cf_list_logpush_jobs",
    {
      title: "List Logpush jobs",
      description: "List Logpush jobs configured for a zone.",
      inputSchema: { zone: zoneParam },
    },
    async ({ zone }) => {
      const z_ = await resolveZone(zone);
      const resp = await cfFetch<Array<Record<string, unknown>>>(`/zones/${z_.id}/logpush/jobs`);
      return textResult({ zone: z_.name, jobs: resp.result.map(redactJob) });
    }
  );

  server.registerTool(
    "cf_create_logpush_job",
    {
      title: "Create a Logpush job",
      description:
        "Create a Logpush job that ships logs to a destination (R2, S3, GCS, an HTTP endpoint, etc). " +
        "destination_conf is e.g. 'r2://my-bucket/logs?account-id=<id>&access-key-id=<k>&secret-access-key=<s>'. " +
        "Requires confirm=true — this sends your traffic data (and the destination_conf credentials) to an external location.",
      inputSchema: {
        zone: zoneParam,
        name: z.string(),
        dataset: z.string().optional().default("http_requests").describe("e.g. http_requests, firewall_events, dns_logs"),
        destination_conf: z.string().describe("Destination URL with credentials"),
        logpull_options: z.string().optional().describe("e.g. fields=RayID,ClientIP&timestamps=rfc3339"),
        enabled: z.boolean().optional().default(true),
        confirm: z.boolean().describe("Must be true — this ships data to an external destination"),
      },
    },
    async ({ zone, name, dataset, destination_conf, logpull_options, enabled, confirm }) => {
      requireConfirm(confirm, `create Logpush job "${name}" shipping to an external destination`);
      const z_ = await resolveZone(zone);
      const resp = await cfFetch(`/zones/${z_.id}/logpush/jobs`, {
        method: "POST",
        body: compact({ name, dataset, destination_conf, logpull_options, enabled }),
      });
      return textResult({ zone: z_.name, job: redactJob(resp.result) });
    }
  );

  server.registerTool(
    "cf_delete_logpush_job",
    {
      title: "Delete a Logpush job",
      description: "Delete a Logpush job. Requires confirm=true.",
      inputSchema: {
        zone: zoneParam,
        job_id: z.number().int().describe("Logpush job ID"),
        confirm: z.boolean().describe("Must be true to actually delete"),
      },
    },
    async ({ zone, job_id, confirm }) => {
      requireConfirm(confirm, `delete Logpush job ${job_id}`);
      const z_ = await resolveZone(zone);
      await cfFetch(`/zones/${z_.id}/logpush/jobs/${job_id}`, { method: "DELETE" });
      return textResult({ zone: z_.name, deletedJob: job_id });
    }
  );
}
