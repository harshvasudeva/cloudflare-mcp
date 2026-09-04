import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cfFetch, resolveAccountId, seg } from "../cloudflare.js";
import { textResult, requireConfirm, jsonObject, accountParam } from "../util.js";

const bucketParam = z.string().describe("R2 bucket name");

export function registerR2Tools(server: McpServer): void {
  server.registerTool(
    "cf_list_r2_buckets",
    {
      title: "List R2 buckets",
      description: "List R2 buckets on the account.",
      inputSchema: {
        account: accountParam,
        name_contains: z.string().optional().describe("Filter to buckets whose name contains this substring"),
      },
    },
    async ({ account, name_contains }) => {
      const acct = await resolveAccountId(account);
      const resp = await cfFetch<{ buckets: Array<Record<string, unknown>> }>(`/accounts/${acct}/r2/buckets`, {
        query: { name_contains },
      });
      return textResult({ account: acct, ...resp.result });
    }
  );

  server.registerTool(
    "cf_create_r2_bucket",
    {
      title: "Create an R2 bucket",
      description: "Create a new R2 bucket. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        name: bucketParam,
        location_hint: z
          .enum(["apac", "eeur", "enam", "weur", "wnam", "oc"])
          .optional()
          .describe("Preferred storage region hint"),
        storage_class: z.enum(["Standard", "InfrequentAccess"]).optional().default("Standard"),
        confirm: z.boolean().describe("Must be true — this creates persistent object storage"),
      },
    },
    async ({ account, name, location_hint, storage_class, confirm }) => {
      requireConfirm(confirm, `create R2 bucket "${name}"`);
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/r2/buckets`, {
        method: "POST",
        body: { name, locationHint: location_hint, storageClass: storage_class },
      });
      return textResult({ created: name, bucket: resp.result });
    }
  );

  server.registerTool(
    "cf_get_r2_bucket",
    {
      title: "Get an R2 bucket",
      description: "Get details for a single R2 bucket.",
      inputSchema: { account: accountParam, bucket: bucketParam },
    },
    async ({ account, bucket }) => {
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/r2/buckets/${seg(bucket)}`);
      return textResult(resp.result);
    }
  );

  server.registerTool(
    "cf_delete_r2_bucket",
    {
      title: "Delete an R2 bucket",
      description:
        "Permanently delete an R2 bucket. The bucket must already be empty. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        bucket: bucketParam,
        confirm: z.boolean().describe("Must be true to actually delete"),
      },
    },
    async ({ account, bucket, confirm }) => {
      requireConfirm(confirm, `delete R2 bucket "${bucket}"`);
      const acct = await resolveAccountId(account);
      await cfFetch(`/accounts/${acct}/r2/buckets/${seg(bucket)}`, { method: "DELETE" });
      return textResult({ deleted: bucket });
    }
  );

  server.registerTool(
    "cf_get_r2_cors",
    {
      title: "Get R2 bucket CORS policy",
      description: "Get the CORS rules configured on an R2 bucket.",
      inputSchema: { account: accountParam, bucket: bucketParam },
    },
    async ({ account, bucket }) => {
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/r2/buckets/${seg(bucket)}/cors`);
      return textResult({ bucket, cors: resp.result });
    }
  );

  server.registerTool(
    "cf_put_r2_cors",
    {
      title: "Set R2 bucket CORS policy",
      description:
        "Replace the CORS rules on an R2 bucket. Each rule looks like " +
        "{allowed: {origins: ['https://example.com'], methods: ['GET'], headers: ['*']}, maxAgeSeconds: 3600}.",
      inputSchema: {
        account: accountParam,
        bucket: bucketParam,
        rules: z.array(jsonObject()).describe("Full replacement list of CORS rules"),
        confirm: z.boolean().describe("Must be true — this replaces the existing policy"),
      },
    },
    async ({ account, bucket, rules, confirm }) => {
      requireConfirm(confirm, `replace CORS policy on R2 bucket "${bucket}"`);
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/r2/buckets/${seg(bucket)}/cors`, {
        method: "PUT",
        body: { rules },
      });
      return textResult({ bucket, cors: resp.result });
    }
  );

  server.registerTool(
    "cf_get_r2_lifecycle",
    {
      title: "Get R2 bucket lifecycle rules",
      description: "Get object lifecycle rules (auto-expiry, storage class transitions) for an R2 bucket.",
      inputSchema: { account: accountParam, bucket: bucketParam },
    },
    async ({ account, bucket }) => {
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/r2/buckets/${seg(bucket)}/lifecycle`);
      return textResult({ bucket, lifecycle: resp.result });
    }
  );

  server.registerTool(
    "cf_put_r2_lifecycle",
    {
      title: "Set R2 bucket lifecycle rules",
      description: "Replace the object lifecycle rules on an R2 bucket.",
      inputSchema: {
        account: accountParam,
        bucket: bucketParam,
        rules: z.array(jsonObject()).describe("Full replacement list of lifecycle rules"),
        confirm: z.boolean().describe("Must be true — this replaces existing rules"),
      },
    },
    async ({ account, bucket, rules, confirm }) => {
      requireConfirm(confirm, `replace lifecycle rules on R2 bucket "${bucket}"`);
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/r2/buckets/${seg(bucket)}/lifecycle`, {
        method: "PUT",
        body: { rules },
      });
      return textResult({ bucket, lifecycle: resp.result });
    }
  );

  server.registerTool(
    "cf_get_r2_public_access",
    {
      title: "Get R2 managed (r2.dev) domain status",
      description: "Check whether the bucket's public r2.dev managed domain is enabled.",
      inputSchema: { account: accountParam, bucket: bucketParam },
    },
    async ({ account, bucket }) => {
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/r2/buckets/${seg(bucket)}/domains/managed`);
      return textResult({ bucket, managedDomain: resp.result });
    }
  );

  server.registerTool(
    "cf_set_r2_public_access",
    {
      title: "Enable or disable the R2 r2.dev domain",
      description:
        "Turn the bucket's public r2.dev managed domain on or off. Enabling makes objects publicly readable on the internet.",
      inputSchema: {
        account: accountParam,
        bucket: bucketParam,
        enabled: z.boolean().describe("true makes the bucket publicly readable via r2.dev"),
        confirm: z.boolean().describe("Must be true — this changes public exposure of the bucket"),
      },
    },
    async ({ account, bucket, enabled, confirm }) => {
      requireConfirm(confirm, `set public r2.dev access on "${bucket}" to ${enabled}`);
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/r2/buckets/${seg(bucket)}/domains/managed`, {
        method: "PUT",
        body: { enabled },
      });
      return textResult({ bucket, managedDomain: resp.result });
    }
  );

  server.registerTool(
    "cf_list_r2_custom_domains",
    {
      title: "List R2 bucket custom domains",
      description: "List custom domains connected to an R2 bucket.",
      inputSchema: { account: accountParam, bucket: bucketParam },
    },
    async ({ account, bucket }) => {
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/r2/buckets/${seg(bucket)}/domains/custom`);
      return textResult({ bucket, domains: resp.result });
    }
  );

  server.registerTool(
    "cf_add_r2_custom_domain",
    {
      title: "Connect a custom domain to an R2 bucket",
      description: "Attach a custom hostname to an R2 bucket for public access. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        bucket: bucketParam,
        domain: z.string().describe("Hostname, e.g. files.example.com"),
        zone_id: z.string().describe("Zone ID that owns the hostname"),
        enabled: z.boolean().optional().default(true),
        min_tls: z.enum(["1.0", "1.1", "1.2", "1.3"]).optional(),
        confirm: z.boolean().describe("Must be true — this exposes bucket contents at this hostname"),
      },
    },
    async ({ account, bucket, domain, zone_id, enabled, min_tls, confirm }) => {
      requireConfirm(confirm, `connect domain "${domain}" to R2 bucket "${bucket}"`);
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/r2/buckets/${seg(bucket)}/domains/custom`, {
        method: "POST",
        body: { domain, zoneId: zone_id, enabled, minTLS: min_tls },
      });
      return textResult({ bucket, domain: resp.result });
    }
  );

  server.registerTool(
    "cf_remove_r2_custom_domain",
    {
      title: "Disconnect an R2 custom domain",
      description: "Remove a custom hostname from an R2 bucket. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        bucket: bucketParam,
        domain: z.string(),
        confirm: z.boolean().describe("Must be true to actually remove"),
      },
    },
    async ({ account, bucket, domain, confirm }) => {
      requireConfirm(confirm, `disconnect domain "${domain}" from R2 bucket "${bucket}"`);
      const acct = await resolveAccountId(account);
      await cfFetch(`/accounts/${acct}/r2/buckets/${seg(bucket)}/domains/custom/${seg(domain)}`, {
        method: "DELETE",
      });
      return textResult({ bucket, removedDomain: domain });
    }
  );

  server.registerTool(
    "cf_get_r2_event_notifications",
    {
      title: "Get R2 event notification rules",
      description: "Get the event notification configuration (which bucket events publish to which queues).",
      inputSchema: { account: accountParam, bucket: bucketParam },
    },
    async ({ account, bucket }) => {
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/event_notifications/r2/${seg(bucket)}/configuration`);
      return textResult({ bucket, notifications: resp.result });
    }
  );

  server.registerTool(
    "cf_put_r2_event_notification",
    {
      title: "Set R2 event notifications to a queue",
      description:
        "Configure which R2 bucket events publish to a Queue. Actions are e.g. PutObject, DeleteObject, CopyObject, " +
        "CompleteMultipartUpload. Replaces any existing configuration for this queue, so requires confirm=true.",
      inputSchema: {
        account: accountParam,
        bucket: bucketParam,
        queue_id: z.string().describe("Target Queue ID"),
        rules: z
          .array(jsonObject())
          .describe("Rules, e.g. [{actions: ['PutObject'], prefix: 'uploads/'}]"),
        confirm: z.boolean().describe("Must be true — this replaces the existing notification config"),
      },
    },
    async ({ account, bucket, queue_id, rules, confirm }) => {
      requireConfirm(confirm, `set event notifications from R2 bucket "${bucket}" to queue ${queue_id}`);
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(
        `/accounts/${acct}/event_notifications/r2/${seg(bucket)}/configuration/queues/${seg(queue_id)}`,
        { method: "PUT", body: { rules } }
      );
      return textResult({ bucket, queue: queue_id, result: resp.result });
    }
  );
}
