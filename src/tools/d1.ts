import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cfFetch, cfFetchAll, resolveAccountId, makeNameResolver } from "../cloudflare.js";
import { textResult, requireConfirm } from "../util.js";

const accountParam = z.string().optional().describe("Account ID; defaults to CF_ACCOUNT_ID.");
const dbParam = z.string().describe("D1 database — either its UUID or its name");

type D1Database = { uuid: string; name: string };

const dbResolver = makeNameResolver<D1Database>({
  listPath: (account) => `/accounts/${account}/d1/database`,
  idOf: (d) => d.uuid,
  nameOf: (d) => d.name,
  idPattern: /^[0-9a-f-]{36}$/i,
  label: "D1 database",
});

/**
 * D1's /query endpoint has no read-only mode and runs `;`-separated
 * statements in one call, so this can only be a heuristic gate, not a
 * guarantee. It closes the two concrete bypasses found in testing:
 *   - multi-statement input ("SELECT 1; DROP TABLE users") — any SQL with
 *     more than one non-empty statement always requires confirm, regardless
 *     of what the first keyword is.
 *   - CTEs and PRAGMA — both dropped from the free-read allowlist, since a
 *     WITH ... can wrap a write and some PRAGMAs mutate state.
 * Only a single, plain SELECT/EXPLAIN statement is treated as a safe read.
 */
function isSafeRead(sql: string): boolean {
  const statements = sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (statements.length !== 1) return false;
  return /^(select|explain)\b/i.test(statements[0]);
}

export function registerD1Tools(server: McpServer): void {
  server.registerTool(
    "cf_list_d1_databases",
    {
      title: "List D1 databases",
      description: "List D1 SQL databases on the account.",
      inputSchema: { account: accountParam },
    },
    async ({ account }) => {
      const acct = await resolveAccountId(account);
      const databases = await cfFetchAll<D1Database>(`/accounts/${acct}/d1/database`);
      return textResult({ account: acct, databases });
    }
  );

  server.registerTool(
    "cf_create_d1_database",
    {
      title: "Create a D1 database",
      description: "Create a new D1 SQL database.",
      inputSchema: {
        account: accountParam,
        name: z.string().describe("Database name"),
        primary_location_hint: z.string().optional().describe("Region hint, e.g. wnam, weur, apac"),
      },
    },
    async ({ account, name, primary_location_hint }) => {
      const acct = await resolveAccountId(account);
      const resp = await cfFetch<D1Database>(`/accounts/${acct}/d1/database`, {
        method: "POST",
        body: { name, primary_location_hint },
      });
      dbResolver.remember(acct, name, resp.result.uuid);
      return textResult({ created: name, database: resp.result });
    }
  );

  server.registerTool(
    "cf_get_d1_database",
    {
      title: "Get a D1 database",
      description: "Get details for a D1 database, including size and table count.",
      inputSchema: { account: accountParam, database: dbParam },
    },
    async ({ account, database }) => {
      const acct = await resolveAccountId(account);
      const id = await dbResolver.resolve(acct, database);
      const resp = await cfFetch(`/accounts/${acct}/d1/database/${id}`);
      return textResult(resp.result);
    }
  );

  server.registerTool(
    "cf_delete_d1_database",
    {
      title: "Delete a D1 database",
      description: "Permanently delete a D1 database and all its data. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        database: dbParam,
        confirm: z.boolean().describe("Must be true to actually delete"),
      },
    },
    async ({ account, database, confirm }) => {
      requireConfirm(confirm, `delete D1 database "${database}" and all its data`);
      const acct = await resolveAccountId(account);
      const id = await dbResolver.resolve(acct, database);
      await cfFetch(`/accounts/${acct}/d1/database/${id}`, { method: "DELETE" });
      dbResolver.forget(acct, database);
      return textResult({ deleted: database });
    }
  );

  server.registerTool(
    "cf_d1_query",
    {
      title: "Run SQL against D1",
      description:
        "Execute a SQL statement against a D1 database. Use '?' placeholders with params for safe value binding. " +
        "A single plain SELECT or EXPLAIN runs freely; anything else (INSERT/UPDATE/DELETE/DDL, multi-statement " +
        "input, WITH, PRAGMA) requires confirm=true, since D1 has no read-only mode to enforce this server-side.",
      inputSchema: {
        account: accountParam,
        database: dbParam,
        sql: z.string().describe("SQL statement; use ? placeholders for bound values"),
        params: z.array(z.string()).optional().describe("Values bound to the ? placeholders, in order"),
        confirm: z
          .boolean()
          .optional()
          .describe("Required (true) for anything but a single plain SELECT/EXPLAIN"),
      },
    },
    async ({ account, database, sql, params, confirm }) => {
      if (!isSafeRead(sql)) {
        requireConfirm(confirm, `run a non-read-only or multi-statement SQL against D1 database "${database}"`);
      }
      const acct = await resolveAccountId(account);
      const id = await dbResolver.resolve(acct, database);
      const resp = await cfFetch(`/accounts/${acct}/d1/database/${id}/query`, {
        method: "POST",
        body: { sql, params },
      });
      return textResult({ database, sql, result: resp.result });
    }
  );

  server.registerTool(
    "cf_d1_list_tables",
    {
      title: "List D1 tables",
      description: "List the tables in a D1 database along with their CREATE statements.",
      inputSchema: { account: accountParam, database: dbParam },
    },
    async ({ account, database }) => {
      const acct = await resolveAccountId(account);
      const id = await dbResolver.resolve(acct, database);
      const resp = await cfFetch(`/accounts/${acct}/d1/database/${id}/query`, {
        method: "POST",
        body: {
          // GLOB (not LIKE) so '_' is literal — LIKE's '_' is a single-char
          // wildcard and would also hide ordinary tables like "acfx_orders".
          sql: "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name",
        },
      });
      return textResult({ database, tables: resp.result });
    }
  );

  server.registerTool(
    "cf_d1_export",
    {
      title: "Export a D1 database",
      description: "Start a SQL dump of a D1 database. Returns a signed URL to download the dump when ready.",
      inputSchema: {
        account: accountParam,
        database: dbParam,
        no_data: z.boolean().optional().default(false).describe("Export schema only, without rows"),
      },
    },
    async ({ account, database, no_data }) => {
      const acct = await resolveAccountId(account);
      const id = await dbResolver.resolve(acct, database);
      const resp = await cfFetch(`/accounts/${acct}/d1/database/${id}/export`, {
        method: "POST",
        body: { output_format: "polling", dump_options: { no_data } },
      });
      return textResult({ database, export: resp.result });
    }
  );
}
