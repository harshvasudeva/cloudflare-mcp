import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cfFetch, cfFetchRaw, cfFetchAll, resolveAccountId, makeNameResolver } from "../cloudflare.js";
import { textResult, requireConfirm, jsonObject, accountParam } from "../util.js";

const nsParam = z.string().describe("KV namespace — either its ID or its title/name");

type KvNamespace = { id: string; title: string };

const nsResolver = makeNameResolver<KvNamespace>({
  listPath: (account) => `/accounts/${account}/storage/kv/namespaces`,
  idOf: (n) => n.id,
  nameOf: (n) => n.title,
  idPattern: /^[0-9a-f]{32}$/i,
  label: "KV namespace",
});

export function registerKvTools(server: McpServer): void {
  server.registerTool(
    "cf_list_kv_namespaces",
    {
      title: "List KV namespaces",
      description: "List Workers KV namespaces on the account.",
      inputSchema: { account: accountParam },
    },
    async ({ account }) => {
      const acct = await resolveAccountId(account);
      const namespaces = await cfFetchAll<KvNamespace>(`/accounts/${acct}/storage/kv/namespaces`);
      return textResult({ account: acct, namespaces });
    }
  );

  server.registerTool(
    "cf_create_kv_namespace",
    {
      title: "Create a KV namespace",
      description: "Create a new Workers KV namespace. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        title: z.string().describe("Namespace title"),
        confirm: z.boolean().describe("Must be true — this creates persistent storage"),
      },
    },
    async ({ account, title, confirm }) => {
      requireConfirm(confirm, `create KV namespace "${title}"`);
      const acct = await resolveAccountId(account);
      const resp = await cfFetch<KvNamespace>(`/accounts/${acct}/storage/kv/namespaces`, {
        method: "POST",
        body: { title },
      });
      nsResolver.remember(acct, title, resp.result.id);
      return textResult({ created: title, namespace: resp.result });
    }
  );

  server.registerTool(
    "cf_rename_kv_namespace",
    {
      title: "Rename a KV namespace",
      description: "Change the title of an existing KV namespace. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        namespace: nsParam,
        title: z.string().describe("New title"),
        confirm: z.boolean().describe("Must be true — this changes a live namespace"),
      },
    },
    async ({ account, namespace, title, confirm }) => {
      requireConfirm(confirm, `rename KV namespace "${namespace}" to "${title}"`);
      const acct = await resolveAccountId(account);
      const nsId = await nsResolver.resolve(acct, namespace);
      await cfFetch(`/accounts/${acct}/storage/kv/namespaces/${nsId}`, { method: "PUT", body: { title } });
      nsResolver.forget(acct, namespace);
      nsResolver.remember(acct, title, nsId);
      return textResult({ namespace: nsId, title });
    }
  );

  server.registerTool(
    "cf_delete_kv_namespace",
    {
      title: "Delete a KV namespace",
      description: "Permanently delete a KV namespace and everything in it. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        namespace: nsParam,
        confirm: z.boolean().describe("Must be true to actually delete"),
      },
    },
    async ({ account, namespace, confirm }) => {
      requireConfirm(confirm, `delete KV namespace "${namespace}" and all its keys`);
      const acct = await resolveAccountId(account);
      const nsId = await nsResolver.resolve(acct, namespace);
      await cfFetch(`/accounts/${acct}/storage/kv/namespaces/${nsId}`, { method: "DELETE" });
      nsResolver.forget(acct, namespace);
      return textResult({ deleted: namespace });
    }
  );

  server.registerTool(
    "cf_list_kv_keys",
    {
      title: "List keys in a KV namespace",
      description: "List keys stored in a KV namespace, optionally filtered by prefix.",
      inputSchema: {
        account: accountParam,
        namespace: nsParam,
        prefix: z.string().optional(),
        limit: z.number().int().positive().max(1000).optional().default(200),
        cursor: z.string().optional().describe("Cursor from a previous truncated listing"),
      },
    },
    async ({ account, namespace, prefix, limit, cursor }) => {
      const acct = await resolveAccountId(account);
      const nsId = await nsResolver.resolve(acct, namespace);
      const resp = await cfFetch<Array<Record<string, unknown>>>(
        `/accounts/${acct}/storage/kv/namespaces/${nsId}/keys`,
        { query: { prefix, limit, cursor } }
      );
      return textResult({ namespace, keys: resp.result, cursor: resp.result_info?.cursor });
    }
  );

  server.registerTool(
    "cf_get_kv_value",
    {
      title: "Read a KV value",
      description:
        "Read the value stored at a key in a KV namespace. base64:true means the value is binary, base64-encoded.",
      inputSchema: { account: accountParam, namespace: nsParam, key: z.string() },
    },
    async ({ account, namespace, key }) => {
      const acct = await resolveAccountId(account);
      const nsId = await nsResolver.resolve(acct, namespace);
      const value = await cfFetchRaw(
        `/accounts/${acct}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(key)}`
      );
      return textResult({ namespace, key, ...value });
    }
  );

  server.registerTool(
    "cf_get_kv_metadata",
    {
      title: "Read KV key metadata",
      description: "Read the metadata attached to a KV key (without reading the value).",
      inputSchema: { account: accountParam, namespace: nsParam, key: z.string() },
    },
    async ({ account, namespace, key }) => {
      const acct = await resolveAccountId(account);
      const nsId = await nsResolver.resolve(acct, namespace);
      const resp = await cfFetch(
        `/accounts/${acct}/storage/kv/namespaces/${nsId}/metadata/${encodeURIComponent(key)}`
      );
      return textResult({ namespace, key, metadata: resp.result });
    }
  );

  server.registerTool(
    "cf_put_kv_value",
    {
      title: "Write a KV value",
      description:
        "Write a value to a key in a KV namespace, with optional TTL and metadata. Overwrites any existing " +
        "value at that key without warning, so requires confirm=true.",
      inputSchema: {
        account: accountParam,
        namespace: nsParam,
        key: z.string(),
        value: z.string().describe("Value to store"),
        expiration_ttl: z.number().int().min(60).optional().describe("Seconds until the key expires (min 60)"),
        expiration: z.number().int().optional().describe("Absolute expiry as a unix timestamp"),
        metadata: jsonObject().optional().describe("Arbitrary JSON metadata to attach"),
        confirm: z.boolean().describe("Must be true — this may overwrite an existing value"),
      },
    },
    async ({ account, namespace, key, value, expiration_ttl, expiration, metadata, confirm }) => {
      requireConfirm(confirm, `write key "${key}" in KV namespace "${namespace}"`);
      const acct = await resolveAccountId(account);
      const nsId = await nsResolver.resolve(acct, namespace);

      const form = new FormData();
      form.append("value", value);
      form.append("metadata", JSON.stringify(metadata ?? {}));

      await cfFetch(`/accounts/${acct}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(key)}`, {
        method: "PUT",
        form,
        query: { expiration_ttl, expiration },
      });
      return textResult({ namespace, key, written: true, bytes: value.length });
    }
  );

  server.registerTool(
    "cf_bulk_put_kv",
    {
      title: "Bulk write KV values",
      description:
        "Write many key/value pairs to a KV namespace in one request (up to 10,000 per call). Overwrites any " +
        "existing values at those keys without warning, so requires confirm=true.",
      inputSchema: {
        account: accountParam,
        namespace: nsParam,
        entries: z
          .array(
            z.object({
              key: z.string(),
              value: z.string(),
              expiration_ttl: z.number().int().optional(),
              metadata: jsonObject().optional(),
            })
          )
          .describe("Key/value pairs to write"),
        confirm: z.boolean().describe("Must be true — this may overwrite existing values"),
      },
    },
    async ({ account, namespace, entries, confirm }) => {
      requireConfirm(confirm, `bulk-write ${entries.length} key(s) in KV namespace "${namespace}"`);
      const acct = await resolveAccountId(account);
      const nsId = await nsResolver.resolve(acct, namespace);
      const resp = await cfFetch(`/accounts/${acct}/storage/kv/namespaces/${nsId}/bulk`, {
        method: "PUT",
        body: entries,
      });
      return textResult({ namespace, written: entries.length, result: resp.result });
    }
  );

  server.registerTool(
    "cf_delete_kv_value",
    {
      title: "Delete KV key(s)",
      description: "Delete one key (key) or many (keys) from a KV namespace. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        namespace: nsParam,
        key: z.string().optional(),
        keys: z.array(z.string()).optional(),
        confirm: z.boolean().describe("Must be true to actually delete"),
      },
    },
    async ({ account, namespace, key, keys, confirm }) => {
      const targets = keys?.length ? keys : key ? [key] : [];
      if (targets.length === 0) throw new Error("Provide either 'key' or 'keys'.");
      requireConfirm(confirm, `delete ${targets.length} key(s) from KV namespace "${namespace}"`);

      const acct = await resolveAccountId(account);
      const nsId = await nsResolver.resolve(acct, namespace);

      if (targets.length === 1) {
        await cfFetch(
          `/accounts/${acct}/storage/kv/namespaces/${nsId}/values/${encodeURIComponent(targets[0])}`,
          { method: "DELETE" }
        );
      } else {
        await cfFetch(`/accounts/${acct}/storage/kv/namespaces/${nsId}/bulk`, {
          method: "DELETE",
          body: targets,
        });
      }
      return textResult({ namespace, deleted: targets });
    }
  );
}
