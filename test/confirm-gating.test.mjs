// Regression test for the confirm-gating safety mechanism.
//
// This codebase's entire safety model is: every tool that deletes, overwrites,
// or otherwise affects live state must require confirm=true. That guarantee is
// only as good as every individual tool remembering to declare it — this test
// catches the exact class of bug the code review found: a tool whose
// description promises "Requires confirm=true" but whose schema (or runtime
// check) doesn't actually enforce it.
//
// Runs against the *built* server (dist/index.js) over real stdio, using the
// actual MCP protocol — not a mock — so a regression in the SDK's schema
// wiring would be caught too. No live Cloudflare credentials are exercised:
// this only lists tools and inspects schemas, it never calls a tool.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, "..", "dist", "index.js");

/** Tools where "confirm" is conditionally required (documented exception, not a gap). */
const CONDITIONAL_CONFIRM = new Set([
  "cf_get_r2_object", // only needed when save_to is set (a plain read otherwise)
  "cf_queue_ack", // only needed when acks (not just retries) are present
  "cf_d1_query", // only needed for non-read SQL (checked at runtime via isSafeRead, not the schema)
]);

function listTools() {
  return new Promise((resolve, reject) => {
    const proc = spawn("node", [SERVER_PATH], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d));

    const send = (msg) => proc.stdin.write(JSON.stringify(msg) + "\n");
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });

    proc.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        } else if (msg.id === 2) {
          proc.kill();
          resolve(msg.result.tools);
        }
      }
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`tools/list timed out. stderr: ${stderr}`));
    }, 20_000);
    proc.on("exit", () => clearTimeout(timer));
  });
}

test("every tool that promises confirm=true actually requires it in its schema", async () => {
  const tools = await listTools();
  assert.ok(tools.length > 100, `expected 100+ tools, got ${tools.length}`);

  const failures = [];
  for (const tool of tools) {
    const promisesConfirm = /confirm\s*[=:]\s*true/i.test(tool.description ?? "");
    if (!promisesConfirm) continue;

    const props = tool.inputSchema?.properties ?? {};
    const hasConfirmProp = props.confirm?.type === "boolean";
    if (!hasConfirmProp) {
      failures.push(`${tool.name}: description promises confirm=true but schema has no boolean 'confirm' property`);
      continue;
    }

    const required = tool.inputSchema?.required ?? [];
    const isRequired = required.includes("confirm");
    if (!isRequired && !CONDITIONAL_CONFIRM.has(tool.name)) {
      failures.push(
        `${tool.name}: description promises confirm=true but 'confirm' is optional in the schema ` +
          `(add it to CONDITIONAL_CONFIRM in this test if that's intentional)`
      );
    }
  }

  assert.deepEqual(failures, [], failures.join("\n"));
});

test("every CONDITIONAL_CONFIRM entry still declares a confirm property", async () => {
  const tools = await listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));

  for (const name of CONDITIONAL_CONFIRM) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} is in CONDITIONAL_CONFIRM but no longer exists as a tool — remove it from the set`);
    assert.equal(
      tool.inputSchema?.properties?.confirm?.type,
      "boolean",
      `${name}: expected a boolean 'confirm' property even though it's conditionally required`
    );
  }
});
