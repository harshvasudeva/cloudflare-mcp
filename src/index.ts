import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerZoneTools } from "./tools/zones.js";
import { registerDnsTools } from "./tools/dns.js";
import { registerWorkerTools } from "./tools/workers.js";
import { registerR2Tools } from "./tools/r2.js";
import { registerKvTools } from "./tools/kv.js";
import { registerD1Tools } from "./tools/d1.js";
import { registerQueueTools } from "./tools/queues.js";
import { registerPagesTools } from "./tools/pages.js";
import { registerCacheTools } from "./tools/cache.js";
import { registerFirewallTools } from "./tools/firewall.js";
import { registerRulesTools } from "./tools/rules.js";
import { registerAnalyticsTools } from "./tools/analytics.js";

type ToolRegistrar = (server: McpServer) => void | Promise<void>;

const MODULES: Record<string, ToolRegistrar> = {
  // `zones` is always registered — it carries cf_verify_token / cf_check_permissions.
  dns: registerDnsTools,
  workers: registerWorkerTools,
  r2: registerR2Tools,
  // Keep the AWS SDK out of processes that explicitly disable r2-objects.
  "r2-objects": async (server) => {
    const { registerR2ObjectTools } = await import("./tools/r2-objects.js");
    registerR2ObjectTools(server);
  },
  kv: registerKvTools,
  d1: registerD1Tools,
  queues: registerQueueTools,
  pages: registerPagesTools,
  cache: registerCacheTools,
  firewall: registerFirewallTools,
  rules: registerRulesTools,
  analytics: registerAnalyticsTools,
};

/**
 * All modules load by default. Set CF_MODULES to a comma-separated subset
 * (e.g. "dns,workers,r2") to register a slimmer server — useful for clients
 * that degrade with very large tool lists.
 */
function selectedModules(): string[] {
  const raw = process.env.CF_MODULES?.trim();
  if (!raw) return Object.keys(MODULES);

  const requested = raw
    .split(",")
    .map((m) => m.trim().toLowerCase())
    .filter(Boolean);

  const unknown = requested.filter((m) => !(m in MODULES));
  if (unknown.length) {
    // stderr is safe on a stdio transport; stdout is reserved for protocol traffic.
    console.error(
      `[cloudflare-mcp] Ignoring unknown CF_MODULES entries: ${unknown.join(", ")}. ` +
        `Valid: ${Object.keys(MODULES).join(", ")}`
    );
  }
  return requested.filter((m) => m in MODULES);
}

const server = new McpServer({
  name: "cloudflare-mcp",
  version: "2.0.0",
});

registerZoneTools(server);
for (const name of selectedModules()) {
  await MODULES[name](server);
}

const transport = new StdioServerTransport();
await server.connect(transport);
