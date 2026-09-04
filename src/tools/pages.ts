import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cfFetch, cfFetchAll, resolveAccountId, seg } from "../cloudflare.js";
import { textResult, requireConfirm, compact, jsonObject, accountParam } from "../util.js";

const projectParam = z.string().describe("Pages project name");

export function registerPagesTools(server: McpServer): void {
  server.registerTool(
    "cf_list_pages_projects",
    {
      title: "List Pages projects",
      description: "List Cloudflare Pages projects on the account.",
      inputSchema: { account: accountParam },
    },
    async ({ account }) => {
      const acct = await resolveAccountId(account);
      // Unlike every other list endpoint in this server, Pages projects only
      // accepts per_page=10 (its own fixed default) — anything else 400s
      // with "Invalid list options provided", confirmed against the live API.
      const projects = await cfFetchAll<Record<string, unknown>>(`/accounts/${acct}/pages/projects`, {}, 10);
      // The full project payload is very large; return the fields that identify and locate a project.
      return textResult({
        account: acct,
        projects: projects.map((p) => ({
          name: p.name,
          subdomain: p.subdomain,
          domains: p.domains,
          production_branch: p.production_branch,
          created_on: p.created_on,
        })),
      });
    }
  );

  server.registerTool(
    "cf_get_pages_project",
    {
      title: "Get a Pages project",
      description: "Get the full configuration of a Pages project, including build config and deployment settings.",
      inputSchema: { account: accountParam, project: projectParam },
    },
    async ({ account, project }) => {
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/pages/projects/${seg(project)}`);
      return textResult(resp.result);
    }
  );

  server.registerTool(
    "cf_create_pages_project",
    {
      title: "Create a Pages project",
      description: "Create a new Cloudflare Pages project. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        name: z.string().describe("Project name (becomes <name>.pages.dev)"),
        production_branch: z.string().optional().default("main"),
        build_config: jsonObject()
          .optional()
          .describe("e.g. {build_command: 'npm run build', destination_dir: 'dist'}"),
        source: jsonObject().optional().describe("Git source config, if connecting a repository"),
        confirm: z.boolean().describe("Must be true — this creates a live Pages project"),
      },
    },
    async ({ account, name, production_branch, build_config, source, confirm }) => {
      requireConfirm(confirm, `create Pages project "${name}"`);
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/pages/projects`, {
        method: "POST",
        body: compact({ name, production_branch, build_config, source }),
      });
      return textResult({ created: name, project: resp.result });
    }
  );

  server.registerTool(
    "cf_update_pages_project",
    {
      title: "Update a Pages project",
      description:
        "Patch a Pages project's build config, production branch, or deployment settings. Requires confirm=true — " +
        "this can change live env vars and bindings.",
      inputSchema: {
        account: accountParam,
        project: projectParam,
        production_branch: z.string().optional(),
        build_config: jsonObject().optional(),
        deployment_configs: jsonObject().optional().describe("Per-environment env vars and bindings"),
        confirm: z.boolean().describe("Must be true — this can change live env vars and bindings"),
      },
    },
    async ({ account, project, production_branch, build_config, deployment_configs, confirm }) => {
      requireConfirm(confirm, `update Pages project "${project}"`);
      const acct = await resolveAccountId(account);
      const patch = compact({ production_branch, build_config, deployment_configs });
      if (Object.keys(patch).length === 0) throw new Error("Provide at least one field to update.");
      const resp = await cfFetch(`/accounts/${acct}/pages/projects/${seg(project)}`, {
        method: "PATCH",
        body: patch,
      });
      return textResult({ project, result: resp.result });
    }
  );

  server.registerTool(
    "cf_delete_pages_project",
    {
      title: "Delete a Pages project",
      description: "Permanently delete a Pages project and all its deployments. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        project: projectParam,
        confirm: z.boolean().describe("Must be true to actually delete"),
      },
    },
    async ({ account, project, confirm }) => {
      requireConfirm(confirm, `delete Pages project "${project}" and all its deployments`);
      const acct = await resolveAccountId(account);
      await cfFetch(`/accounts/${acct}/pages/projects/${seg(project)}`, { method: "DELETE" });
      return textResult({ deleted: project });
    }
  );

  server.registerTool(
    "cf_list_pages_deployments",
    {
      title: "List Pages deployments",
      description: "List deployments for a Pages project, newest first.",
      inputSchema: {
        account: accountParam,
        project: projectParam,
        env: z.enum(["production", "preview"]).optional(),
      },
    },
    async ({ account, project, env }) => {
      const acct = await resolveAccountId(account);
      const resp = await cfFetch<Array<Record<string, unknown>>>(
        `/accounts/${acct}/pages/projects/${seg(project)}/deployments`,
        { query: { env } }
      );
      return textResult({
        project,
        deployments: resp.result.map((d) => ({
          id: d.id,
          environment: d.environment,
          url: d.url,
          created_on: d.created_on,
          latest_stage: d.latest_stage,
          deployment_trigger: d.deployment_trigger,
        })),
      });
    }
  );

  server.registerTool(
    "cf_get_pages_deployment",
    {
      title: "Get a Pages deployment",
      description: "Get full details of a single Pages deployment.",
      inputSchema: { account: accountParam, project: projectParam, deployment_id: z.string() },
    },
    async ({ account, project, deployment_id }) => {
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(
        `/accounts/${acct}/pages/projects/${seg(project)}/deployments/${seg(deployment_id)}`
      );
      return textResult(resp.result);
    }
  );

  server.registerTool(
    "cf_get_pages_deployment_logs",
    {
      title: "Get Pages build logs",
      description: "Fetch the build log output for a Pages deployment.",
      inputSchema: { account: accountParam, project: projectParam, deployment_id: z.string() },
    },
    async ({ account, project, deployment_id }) => {
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(
        `/accounts/${acct}/pages/projects/${seg(project)}/deployments/${seg(deployment_id)}/history/logs`
      );
      return textResult({ project, deployment_id, logs: resp.result });
    }
  );

  server.registerTool(
    "cf_retry_pages_deployment",
    {
      title: "Retry a Pages deployment",
      description: "Re-run a failed Pages deployment. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        project: projectParam,
        deployment_id: z.string(),
        confirm: z.boolean().describe("Must be true — this starts a deployment"),
      },
    },
    async ({ account, project, deployment_id, confirm }) => {
      requireConfirm(confirm, `retry Pages deployment ${deployment_id} for project "${project}"`);
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(
        `/accounts/${acct}/pages/projects/${seg(project)}/deployments/${seg(deployment_id)}/retry`,
        { method: "POST" }
      );
      return textResult({ project, retried: deployment_id, result: resp.result });
    }
  );

  server.registerTool(
    "cf_rollback_pages_deployment",
    {
      title: "Roll back a Pages deployment",
      description: "Promote a previous deployment back to live. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        project: projectParam,
        deployment_id: z.string().describe("The older deployment to roll back to"),
        confirm: z.boolean().describe("Must be true — this changes what is live"),
      },
    },
    async ({ account, project, deployment_id, confirm }) => {
      requireConfirm(confirm, `roll back Pages project "${project}" to deployment ${deployment_id}`);
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(
        `/accounts/${acct}/pages/projects/${seg(project)}/deployments/${seg(deployment_id)}/rollback`,
        { method: "POST" }
      );
      return textResult({ project, rolledBackTo: deployment_id, result: resp.result });
    }
  );

  server.registerTool(
    "cf_delete_pages_deployment",
    {
      title: "Delete a Pages deployment",
      description: "Delete a single Pages deployment. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        project: projectParam,
        deployment_id: z.string(),
        confirm: z.boolean().describe("Must be true to actually delete"),
      },
    },
    async ({ account, project, deployment_id, confirm }) => {
      requireConfirm(confirm, `delete Pages deployment ${deployment_id}`);
      const acct = await resolveAccountId(account);
      await cfFetch(`/accounts/${acct}/pages/projects/${seg(project)}/deployments/${seg(deployment_id)}`, {
        method: "DELETE",
      });
      return textResult({ project, deleted: deployment_id });
    }
  );

  server.registerTool(
    "cf_list_pages_domains",
    {
      title: "List Pages custom domains",
      description: "List custom domains attached to a Pages project.",
      inputSchema: { account: accountParam, project: projectParam },
    },
    async ({ account, project }) => {
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/pages/projects/${seg(project)}/domains`);
      return textResult({ project, domains: resp.result });
    }
  );

  server.registerTool(
    "cf_add_pages_domain",
    {
      title: "Add a Pages custom domain",
      description: "Attach a custom domain to a Pages project. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        project: projectParam,
        domain: z.string(),
        confirm: z.boolean().describe("Must be true — this changes live domain routing"),
      },
    },
    async ({ account, project, domain, confirm }) => {
      requireConfirm(confirm, `add domain "${domain}" to Pages project "${project}"`);
      const acct = await resolveAccountId(account);
      const resp = await cfFetch(`/accounts/${acct}/pages/projects/${seg(project)}/domains`, {
        method: "POST",
        body: { name: domain },
      });
      return textResult({ project, domain: resp.result });
    }
  );

  server.registerTool(
    "cf_remove_pages_domain",
    {
      title: "Remove a Pages custom domain",
      description: "Detach a custom domain from a Pages project. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        project: projectParam,
        domain: z.string(),
        confirm: z.boolean().describe("Must be true to actually remove"),
      },
    },
    async ({ account, project, domain, confirm }) => {
      requireConfirm(confirm, `remove domain "${domain}" from Pages project "${project}"`);
      const acct = await resolveAccountId(account);
      await cfFetch(`/accounts/${acct}/pages/projects/${seg(project)}/domains/${seg(domain)}`, { method: "DELETE" });
      return textResult({ project, removed: domain });
    }
  );
}
