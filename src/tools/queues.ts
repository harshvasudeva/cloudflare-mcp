import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { cfFetch, cfFetchAll, resolveAccountId, makeNameResolver, seg } from "../cloudflare.js";
import { textResult, requireConfirm, compact, jsonObject, accountParam } from "../util.js";

const queueParam = z.string().describe("Queue — either its ID or its name");

type Queue = { queue_id: string; queue_name: string };

const queueResolver = makeNameResolver<Queue>({
  listPath: (account) => `/accounts/${account}/queues`,
  idOf: (q) => q.queue_id,
  nameOf: (q) => q.queue_name,
  idPattern: /^[0-9a-f]{32}$/i,
  label: "queue",
});

export function registerQueueTools(server: McpServer): void {
  server.registerTool(
    "cf_list_queues",
    {
      title: "List Queues",
      description: "List Cloudflare Queues on the account.",
      inputSchema: { account: accountParam },
    },
    async ({ account }) => {
      const acct = await resolveAccountId(account);
      const queues = await cfFetchAll<Queue>(`/accounts/${acct}/queues`);
      return textResult({ account: acct, queues });
    }
  );

  server.registerTool(
    "cf_create_queue",
    {
      title: "Create a Queue",
      description: "Create a new Cloudflare Queue. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        name: z.string().describe("Queue name"),
        confirm: z.boolean().describe("Must be true — this creates persistent queue infrastructure"),
      },
    },
    async ({ account, name, confirm }) => {
      requireConfirm(confirm, `create Queue "${name}"`);
      const acct = await resolveAccountId(account);
      const resp = await cfFetch<Queue>(`/accounts/${acct}/queues`, {
        method: "POST",
        body: { queue_name: name },
      });
      queueResolver.remember(acct, name, resp.result.queue_id);
      return textResult({ created: name, queue: resp.result });
    }
  );

  server.registerTool(
    "cf_get_queue",
    {
      title: "Get a Queue",
      description: "Get details and settings for a Queue.",
      inputSchema: { account: accountParam, queue: queueParam },
    },
    async ({ account, queue }) => {
      const acct = await resolveAccountId(account);
      const id = await queueResolver.resolve(acct, queue);
      const resp = await cfFetch(`/accounts/${acct}/queues/${id}`);
      return textResult(resp.result);
    }
  );

  server.registerTool(
    "cf_update_queue",
    {
      title: "Update Queue settings",
      description: "Rename a Queue or change its delivery settings. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        queue: queueParam,
        name: z.string().optional().describe("New queue name"),
        delivery_delay: z.number().int().optional().describe("Seconds to delay delivery of new messages"),
        message_retention_period: z.number().int().optional().describe("Seconds to retain messages"),
        confirm: z.boolean().describe("Must be true — this changes live queue behaviour"),
      },
    },
    async ({ account, queue, name, delivery_delay, message_retention_period, confirm }) => {
      requireConfirm(confirm, `update Queue "${queue}"`);
      const acct = await resolveAccountId(account);
      const id = await queueResolver.resolve(acct, queue);
      const settings = compact({ delivery_delay, message_retention_period });
      const resp = await cfFetch(`/accounts/${acct}/queues/${id}`, {
        method: "PATCH",
        body: compact({ queue_name: name, settings: Object.keys(settings).length ? settings : undefined }),
      });
      if (name) {
        queueResolver.forget(acct, queue);
        queueResolver.remember(acct, name, id);
      }
      return textResult({ queue, result: resp.result });
    }
  );

  server.registerTool(
    "cf_delete_queue",
    {
      title: "Delete a Queue",
      description: "Permanently delete a Queue and its messages. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        queue: queueParam,
        confirm: z.boolean().describe("Must be true to actually delete"),
      },
    },
    async ({ account, queue, confirm }) => {
      requireConfirm(confirm, `delete Queue "${queue}"`);
      const acct = await resolveAccountId(account);
      const id = await queueResolver.resolve(acct, queue);
      await cfFetch(`/accounts/${acct}/queues/${id}`, { method: "DELETE" });
      queueResolver.forget(acct, queue);
      return textResult({ deleted: queue });
    }
  );

  server.registerTool(
    "cf_list_queue_consumers",
    {
      title: "List Queue consumers",
      description: "List the Workers or HTTP pull consumers attached to a Queue.",
      inputSchema: { account: accountParam, queue: queueParam },
    },
    async ({ account, queue }) => {
      const acct = await resolveAccountId(account);
      const id = await queueResolver.resolve(acct, queue);
      const resp = await cfFetch(`/accounts/${acct}/queues/${id}/consumers`);
      return textResult({ queue, consumers: resp.result });
    }
  );

  server.registerTool(
    "cf_create_queue_consumer",
    {
      title: "Attach a consumer to a Queue",
      description:
        "Attach a consumer to a Queue — either a Worker (type 'worker' with script_name) or HTTP pull (type 'http_pull').",
      inputSchema: {
        account: accountParam,
        queue: queueParam,
        type: z.enum(["worker", "http_pull"]).optional().default("worker"),
        script_name: z.string().optional().describe("Worker script name, required for type 'worker'"),
        batch_size: z.number().int().optional(),
        max_retries: z.number().int().optional(),
        max_wait_time_ms: z.number().int().optional(),
        dead_letter_queue: z.string().optional().describe("Queue name for messages that exhaust retries"),
        confirm: z.boolean().describe("Must be true — this attaches a live message consumer"),
      },
    },
    async ({ account, queue, type, script_name, batch_size, max_retries, max_wait_time_ms, dead_letter_queue, confirm }) => {
      requireConfirm(confirm, `attach a ${type} consumer to Queue "${queue}"`);
      if (type === "worker" && !script_name) throw new Error("script_name is required for a 'worker' consumer.");
      const acct = await resolveAccountId(account);
      const id = await queueResolver.resolve(acct, queue);
      const resp = await cfFetch(`/accounts/${acct}/queues/${id}/consumers`, {
        method: "POST",
        body: compact({
          type,
          script_name,
          dead_letter_queue,
          settings: compact({ batch_size, max_retries, max_wait_time_ms }),
        }),
      });
      return textResult({ queue, consumer: resp.result });
    }
  );

  server.registerTool(
    "cf_delete_queue_consumer",
    {
      title: "Detach a Queue consumer",
      description: "Remove a consumer from a Queue. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        queue: queueParam,
        consumer_id: z.string(),
        confirm: z.boolean().describe("Must be true to actually detach"),
      },
    },
    async ({ account, queue, consumer_id, confirm }) => {
      requireConfirm(confirm, `detach consumer ${consumer_id} from Queue "${queue}"`);
      const acct = await resolveAccountId(account);
      const id = await queueResolver.resolve(acct, queue);
      await cfFetch(`/accounts/${acct}/queues/${id}/consumers/${seg(consumer_id)}`, { method: "DELETE" });
      return textResult({ queue, detachedConsumer: consumer_id });
    }
  );

  server.registerTool(
    "cf_queue_push",
    {
      title: "Push message(s) to a Queue",
      description: "Publish one or more messages onto a Queue. Requires confirm=true.",
      inputSchema: {
        account: accountParam,
        queue: queueParam,
        messages: z
          .array(jsonObject())
          .describe("Messages, e.g. [{body: {...}, content_type: 'json', delay_seconds: 0}]"),
        confirm: z.boolean().describe("Must be true — this delivers messages to live consumers"),
      },
    },
    async ({ account, queue, messages, confirm }) => {
      requireConfirm(confirm, `publish ${messages.length} message(s) to Queue "${queue}"`);
      const acct = await resolveAccountId(account);
      const id = await queueResolver.resolve(acct, queue);
      const path =
        messages.length > 1
          ? `/accounts/${acct}/queues/${id}/messages/batch`
          : `/accounts/${acct}/queues/${id}/messages`;
      const body = messages.length > 1 ? { messages } : messages[0];
      const resp = await cfFetch(path, { method: "POST", body });
      return textResult({ queue, pushed: messages.length, result: resp.result });
    }
  );

  server.registerTool(
    "cf_queue_pull",
    {
      title: "Pull messages from a Queue",
      description:
        "Pull a batch of messages from an http_pull Queue. Messages stay invisible for visibility_timeout_ms until acked, " +
        "so requires confirm=true.",
      inputSchema: {
        account: accountParam,
        queue: queueParam,
        batch_size: z.number().int().positive().max(100).optional().default(10),
        visibility_timeout_ms: z.number().int().optional(),
        confirm: z.boolean().describe("Must be true — this temporarily changes message visibility"),
      },
    },
    async ({ account, queue, batch_size, visibility_timeout_ms, confirm }) => {
      requireConfirm(confirm, `pull messages from Queue "${queue}"`);
      const acct = await resolveAccountId(account);
      const id = await queueResolver.resolve(acct, queue);
      const resp = await cfFetch(`/accounts/${acct}/queues/${id}/messages/pull`, {
        method: "POST",
        body: compact({ batch_size, visibility_timeout_ms }),
      });
      return textResult({ queue, result: resp.result });
    }
  );

  server.registerTool(
    "cf_queue_ack",
    {
      title: "Acknowledge or retry Queue messages",
      description:
        "Acknowledge (permanently delete) pulled messages by lease id, and/or mark others for retry. " +
        "Acknowledging is irreversible, so requires confirm=true.",
      inputSchema: {
        account: accountParam,
        queue: queueParam,
        acks: z.array(z.string()).optional().describe("Lease IDs to acknowledge"),
        retries: z.array(z.string()).optional().describe("Lease IDs to return to the queue"),
        confirm: z.boolean().describe("Must be true — acknowledged messages are permanently removed"),
      },
    },
    async ({ account, queue, acks, retries, confirm }) => {
      if (acks?.length) {
        requireConfirm(confirm, `permanently acknowledge ${acks.length} message(s) on Queue "${queue}"`);
      }
      const acct = await resolveAccountId(account);
      const id = await queueResolver.resolve(acct, queue);
      const resp = await cfFetch(`/accounts/${acct}/queues/${id}/messages/ack`, {
        method: "POST",
        body: {
          acks: (acks ?? []).map((lease_id) => ({ lease_id })),
          retries: (retries ?? []).map((lease_id) => ({ lease_id })),
        },
      });
      return textResult({ queue, result: resp.result });
    }
  );
}
