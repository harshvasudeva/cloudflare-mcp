import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cfFetch, cfFetchRaw, resolveAccountId, resolveZone } from "../cloudflare.js";
import { textResult, rawResult, requireConfirm, compact, jsonObject } from "../util.js";

const accountParam = z
  .string()
  .optional()
  .describe("Account ID. Defaults to CF_ACCOUNT_ID, else the first account the token can see.");

const BINDING_DOC = [
  "Array of binding objects. Every binding needs `type` and `name`, plus type-specific fields:",
  "plain_text{text}, secret_text{text}, kv_namespace{namespace_id}, r2_bucket{bucket_name},",
  "d1{id}, queue{queue_name}, service{service,environment}, durable_object_namespace{class_name},",
  "analytics_engine{dataset}, hyperdrive{id}, vectorize{index_name}, mtls_certificate{certificate_id},",
  "and ai / browser_rendering / assets / version_metadata which need no extra fields.",
].join(" ");

export function registerWorkerTools(server: McpServer): void {
  server.registerTool(
    "cf_list_workers",
    {
      title: "List Workers",
      description: "List all Worker scripts uploaded to the account.",
      inputSchema: { account: accountParam },
    },
    async ({ account }) => {
      const acct = await resolveAccountId(account);
      const resp = await cfFetch<Array<Record<string, unknown>>>(`/accounts/${acct}/workers/scripts`);
      return textResult({ account: acct, workers: resp.result });
    }
  );

  server.registerTool(
    "cf_get_worker",
    {
      title: "Get Worker settings",
      description:
        "Get a Worker's configuration: bindings, compatibility date/flags, logpush, tail consumers, observability.",
      inputSchema: { account: accountParam, name: z.string().describe("Worker script name") },
    },
    async ({ account, name }) => {
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/workers/scripts/${name}/settings`);
      return textResult({ worker: name, settings: resp.result });
    }
  );

  server.registerTool(
    "cf_get_worker_code",
    {
      title: "Get Worker source code",
      description:
        "Download the current source of a Worker. Module workers come back as a multipart body containing each module.",
      inputSchema: { account: accountParam, name: z.string().describe("Worker script name") },
    },
    async ({ account, name }) => {
      const acct = await resolveAccountId(account);
      const body = await cfFetchRaw(`/accounts/${acct}/workers/scripts/${name}/content`);
      return rawResult(body);
    }
  );

  server.registerTool(
    "cf_deploy_worker",
    {
      title: "Deploy a Worker",
      description:
        "Upload and deploy Worker source code, creating the Worker if it does not exist. This overwrites the live " +
        "Worker and creates a new version + deployment, so it requires confirm=true. " +
        BINDING_DOC,
      inputSchema: {
        account: accountParam,
        name: z.string().describe("Worker script name"),
        script: z.string().describe("The Worker source code"),
        main_module: z
          .string()
          .optional()
          .default("worker.mjs")
          .describe("Entry point filename; ignored when format is 'service-worker'"),
        format: z
          .enum(["module", "service-worker"])
          .optional()
          .default("module")
          .describe("ES module syntax (default) or legacy service-worker addEventListener syntax"),
        compatibility_date: z
          .string()
          .optional()
          .describe("Runtime compatibility date, YYYY-MM-DD. Defaults to today."),
        compatibility_flags: z.array(z.string()).optional(),
        bindings: z.array(jsonObject()).optional().describe(BINDING_DOC),
        migrations: jsonObject().optional().describe("Durable Object migrations to apply"),
        logpush: z.boolean().optional(),
        tags: z.array(z.string()).optional(),
        confirm: z.boolean().describe("Must be true — this deploys live code"),
      },
    },
    async (args) => {
      requireConfirm(args.confirm, `deploy Worker "${args.name}"`);
      const acct = await resolveAccountId(args.account);
      const isModule = args.format !== "service-worker";
      const entry = isModule ? args.main_module : "script";
      const compatDate = args.compatibility_date ?? new Date().toISOString().slice(0, 10);

      const metadata = compact({
        ...(isModule ? { main_module: entry } : { body_part: entry }),
        compatibility_date: compatDate,
        compatibility_flags: args.compatibility_flags,
        bindings: args.bindings,
        migrations: args.migrations,
        logpush: args.logpush,
        tags: args.tags,
      });

      const form = new FormData();
      form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
      form.append(
        entry,
        new Blob([args.script], {
          type: isModule ? "application/javascript+module" : "application/javascript",
        }),
        entry
      );

      const resp = await cfFetch(`/accounts/${acct}/workers/scripts/${args.name}`, {
        method: "PUT",
        form,
      });
      return textResult({ deployed: args.name, compatibility_date: compatDate, result: resp.result });
    }
  );

  server.registerTool(
    "cf_delete_worker",
    {
      title: "Delete a Worker",
      description: "Permanently delete a Worker script. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        name: z.string().describe("Worker script name"),
        force: z
          .boolean()
          .optional()
          .default(false)
          .describe("Delete even if other Workers have service bindings to this one"),
        confirm: z.boolean().describe("Must be true to actually delete"),
      },
    },
    async ({ account, name, force, confirm }) => {
      requireConfirm(confirm, `delete Worker "${name}"`);
      const acct = await resolveAccountId(account);
      await cfFetch(`/accounts/${acct}/workers/scripts/${name}`, {
        method: "DELETE",
        query: { force: force ? "true" : undefined },
      });
      return textResult({ deleted: name });
    }
  );

  server.registerTool(
    "cf_update_worker_settings",
    {
      title: "Update Worker settings",
      description:
        "Patch a Worker's settings (bindings, compatibility date/flags, logpush, tail consumers) without reuploading code.",
      inputSchema: {
        account: accountParam,
        name: z.string(),
        compatibility_date: z.string().optional(),
        compatibility_flags: z.array(z.string()).optional(),
        bindings: z.array(jsonObject()).optional().describe(BINDING_DOC),
        logpush: z.boolean().optional(),
        tail_consumers: z.array(jsonObject()).optional(),
        confirm: z.boolean().describe("Must be true — this changes a live Worker"),
      },
    },
    async ({ account, name, confirm, ...rest }) => {
      requireConfirm(confirm, `update settings for Worker "${name}"`);
      const acct = await resolveAccountId(account);
      const settings = compact(rest);
      if (Object.keys(settings).length === 0) {
        throw new Error("Provide at least one setting to update.");
      }
      // This endpoint requires multipart/form-data with a "settings" part —
      // both official Cloudflare SDKs confirm plain JSON is rejected here,
      // unlike most of the API. Mirrors the metadata part in cf_deploy_worker.
      const form = new FormData();
      form.append("settings", new Blob([JSON.stringify(settings)], { type: "application/json" }));
      const resp = await cfFetch(`/accounts/${acct}/workers/scripts/${name}/settings`, {
        method: "PATCH",
        form,
      });
      return textResult({ worker: name, settings: resp.result });
    }
  );

  server.registerTool(
    "cf_list_worker_versions",
    {
      title: "List Worker versions",
      description: "List uploaded versions of a Worker (each upload creates a version).",
      inputSchema: { account: accountParam, name: z.string() },
    },
    async ({ account, name }) => {
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/workers/scripts/${name}/versions`);
      return textResult({ worker: name, versions: resp.result });
    }
  );

  server.registerTool(
    "cf_list_worker_deployments",
    {
      title: "List Worker deployments",
      description: "List deployments for a Worker, showing which version is currently serving traffic.",
      inputSchema: { account: accountParam, name: z.string() },
    },
    async ({ account, name }) => {
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/workers/scripts/${name}/deployments`);
      return textResult({ worker: name, deployments: resp.result });
    }
  );

  server.registerTool(
    "cf_create_worker_deployment",
    {
      title: "Deploy a Worker version (or roll back)",
      description:
        "Point live traffic at specific Worker version(s). Pass a single version_id to roll back or promote it, " +
        "or pass versions[] with percentages for a gradual rollout. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        name: z.string(),
        version_id: z.string().optional().describe("Send 100% of traffic to this version"),
        versions: z
          .array(z.object({ version_id: z.string(), percentage: z.number() }))
          .optional()
          .describe("Split traffic across versions; percentages must total 100"),
        confirm: z.boolean().describe("Must be true — this changes live traffic"),
      },
    },
    async ({ account, name, version_id, versions, confirm }) => {
      requireConfirm(confirm, `change live traffic for Worker "${name}"`);
      const acct = await resolveAccountId(account);
      const payload = versions ?? (version_id ? [{ version_id, percentage: 100 }] : undefined);
      if (!payload) throw new Error("Provide either 'version_id' or 'versions'.");
      const resp = await cfFetch(`/accounts/${acct}/workers/scripts/${name}/deployments`, {
        method: "POST",
        body: { strategy: "percentage", versions: payload },
      });
      return textResult({ worker: name, deployment: resp.result });
    }
  );

  server.registerTool(
    "cf_list_worker_secrets",
    {
      title: "List Worker secrets",
      description: "List secret binding names for a Worker (values are never returned by Cloudflare).",
      inputSchema: { account: accountParam, name: z.string() },
    },
    async ({ account, name }) => {
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/workers/scripts/${name}/secrets`);
      return textResult({ worker: name, secrets: resp.result });
    }
  );

  server.registerTool(
    "cf_put_worker_secret",
    {
      title: "Set a Worker secret",
      description: "Create or overwrite a secret binding on a Worker. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        name: z.string().describe("Worker script name"),
        secret_name: z.string().describe("Binding name the Worker will read"),
        text: z.string().describe("Secret value"),
        confirm: z.boolean().describe("Must be true — this may overwrite an existing secret"),
      },
    },
    async ({ account, name, secret_name, text, confirm }) => {
      requireConfirm(confirm, `set secret "${secret_name}" on Worker "${name}"`);
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/workers/scripts/${name}/secrets`, {
        method: "PUT",
        body: { name: secret_name, text, type: "secret_text" },
      });
      return textResult({ worker: name, secret: resp.result });
    }
  );

  server.registerTool(
    "cf_delete_worker_secret",
    {
      title: "Delete a Worker secret",
      description: "Remove a secret binding from a Worker. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        name: z.string(),
        secret_name: z.string(),
        confirm: z.boolean().describe("Must be true to actually delete"),
      },
    },
    async ({ account, name, secret_name, confirm }) => {
      requireConfirm(confirm, `delete secret "${secret_name}" from Worker "${name}"`);
      const acct = await resolveAccountId(account);
      await cfFetch(`/accounts/${acct}/workers/scripts/${name}/secrets/${secret_name}`, { method: "DELETE" });
      return textResult({ worker: name, deletedSecret: secret_name });
    }
  );

  server.registerTool(
    "cf_get_worker_schedules",
    {
      title: "Get Worker cron triggers",
      description: "List the cron schedules attached to a Worker.",
      inputSchema: { account: accountParam, name: z.string() },
    },
    async ({ account, name }) => {
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/workers/scripts/${name}/schedules`);
      return textResult({ worker: name, schedules: resp.result });
    }
  );

  server.registerTool(
    "cf_update_worker_schedules",
    {
      title: "Set Worker cron triggers",
      description:
        "Replace the full set of cron triggers on a Worker, e.g. [{cron: '*/5 * * * *'}]. Pass an empty array to remove all.",
      inputSchema: {
        account: accountParam,
        name: z.string(),
        schedules: z.array(z.object({ cron: z.string() })).describe("Full replacement list of cron schedules"),
        confirm: z.boolean().describe("Must be true — this replaces all existing triggers"),
      },
    },
    async ({ account, name, schedules, confirm }) => {
      requireConfirm(confirm, `replace cron triggers on Worker "${name}"`);
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/workers/scripts/${name}/schedules`, {
        method: "PUT",
        body: schedules,
      });
      return textResult({ worker: name, schedules: resp.result });
    }
  );

  // --- Routes (zone-scoped) ------------------------------------------------

  server.registerTool(
    "cf_list_worker_routes",
    {
      title: "List Worker routes",
      description: "List URL patterns in a zone that are routed to Workers.",
      inputSchema: { zone: z.string().optional().describe("Zone name or ID; defaults to CF_ZONE") },
    },
    async ({ zone }) => {
      const z_ = await resolveZone(zone);
      const resp = await cfFetch(`/zones/${z_.id}/workers/routes`);
      return textResult({ zone: z_.name, routes: resp.result });
    }
  );

  server.registerTool(
    "cf_create_worker_route",
    {
      title: "Create a Worker route",
      description:
        "Route a URL pattern in a zone to a Worker, e.g. pattern 'example.com/api/*'. Requires confirm=true.",
      inputSchema: {
        zone: z.string().optional(),
        pattern: z.string().describe("URL pattern, e.g. example.com/api/*"),
        script: z.string().optional().describe("Worker script name; omit to disable Workers on this pattern"),
        confirm: z.boolean().describe("Must be true — this changes live request routing"),
      },
    },
    async ({ zone, pattern, script, confirm }) => {
      requireConfirm(confirm, `route "${pattern}" to a Worker`);
      const z_ = await resolveZone(zone);
      const resp = await cfFetch(`/zones/${z_.id}/workers/routes`, {
        method: "POST",
        body: { pattern, script },
      });
      return textResult({ zone: z_.name, route: resp.result });
    }
  );

  server.registerTool(
    "cf_update_worker_route",
    {
      title: "Update a Worker route",
      description:
        "Change the pattern or target script of an existing Worker route. This is a full replace, so requires confirm=true.",
      inputSchema: {
        zone: z.string().optional(),
        id: z.string().describe("Route ID"),
        pattern: z.string().describe("URL pattern"),
        script: z.string().optional(),
        confirm: z.boolean().describe("Must be true — this changes live request routing"),
      },
    },
    async ({ zone, id, pattern, script, confirm }) => {
      requireConfirm(confirm, `update Worker route ${id}`);
      const z_ = await resolveZone(zone);
      const resp = await cfFetch(`/zones/${z_.id}/workers/routes/${id}`, {
        method: "PUT",
        body: { pattern, script },
      });
      return textResult({ zone: z_.name, route: resp.result });
    }
  );

  server.registerTool(
    "cf_delete_worker_route",
    {
      title: "Delete a Worker route",
      description: "Remove a Worker route from a zone. Requires confirm=true.",
      inputSchema: {
        zone: z.string().optional(),
        id: z.string().describe("Route ID"),
        confirm: z.boolean().describe("Must be true to actually delete"),
      },
    },
    async ({ zone, id, confirm }) => {
      requireConfirm(confirm, `delete Worker route ${id}`);
      const z_ = await resolveZone(zone);
      await cfFetch(`/zones/${z_.id}/workers/routes/${id}`, { method: "DELETE" });
      return textResult({ zone: z_.name, deletedRoute: id });
    }
  );

  // --- Domains + subdomain -------------------------------------------------

  server.registerTool(
    "cf_list_worker_domains",
    {
      title: "List Worker custom domains",
      description: "List custom domains attached directly to Workers on this account.",
      inputSchema: { account: accountParam },
    },
    async ({ account }) => {
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/workers/domains`);
      return textResult({ account: acct, domains: resp.result });
    }
  );

  server.registerTool(
    "cf_attach_worker_domain",
    {
      title: "Attach a custom domain to a Worker",
      description:
        "Bind a hostname directly to a Worker (creates the DNS record and route automatically). Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        hostname: z.string().describe("Fully-qualified hostname, e.g. api.example.com"),
        service: z.string().describe("Worker script name"),
        zone: z.string().optional().describe("Zone name or ID that owns the hostname"),
        environment: z.string().optional().default("production"),
        confirm: z.boolean().describe("Must be true — this creates a live DNS record and route"),
      },
    },
    async ({ account, hostname, service, zone, environment, confirm }) => {
      requireConfirm(confirm, `attach domain "${hostname}" to Worker "${service}"`);
      const acct = await resolveAccountId(account);
      const z_ = await resolveZone(zone);
      const resp = await cfFetch(`/accounts/${acct}/workers/domains`, {
        method: "PUT",
        body: { hostname, service, environment, zone_id: z_.id },
      });
      return textResult({ attached: hostname, worker: service, domain: resp.result });
    }
  );

  server.registerTool(
    "cf_detach_worker_domain",
    {
      title: "Detach a Worker custom domain",
      description: "Remove a custom domain binding from a Worker. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        id: z.string().describe("Domain binding ID (from cf_list_worker_domains)"),
        confirm: z.boolean().describe("Must be true to actually detach"),
      },
    },
    async ({ account, id, confirm }) => {
      requireConfirm(confirm, `detach Worker domain ${id}`);
      const acct = await resolveAccountId(account);
      await cfFetch(`/accounts/${acct}/workers/domains/${id}`, { method: "DELETE" });
      return textResult({ detached: id });
    }
  );

  server.registerTool(
    "cf_get_workers_subdomain",
    {
      title: "Get workers.dev subdomain",
      description: "Get the account's workers.dev subdomain.",
      inputSchema: { account: accountParam },
    },
    async ({ account }) => {
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/workers/subdomain`);
      return textResult(resp.result);
    }
  );

  server.registerTool(
    "cf_tail_worker",
    {
      title: "Start a Worker tail session",
      description:
        "Start a log tail session for a Worker. Returns a WebSocket URL that streams live logs; the session expires on its own.",
      inputSchema: { account: accountParam, name: z.string() },
    },
    async ({ account, name }) => {
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/workers/scripts/${name}/tails`, { method: "POST" });
      return textResult({ worker: name, tail: resp.result });
    }
  );
}
