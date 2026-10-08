import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

// Behavioral tests of the actual MCP JSON-RPC handler with a stub transport.
function asModule(source) {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}
const stub = [
  'export const configureSandbox = async () => {};',
  'export const destroySandbox = async () => {};',
  'export const getManagedSandbox = async () => ({id:"sandbox_test"});',
  'export const listManagedSandboxes = async () => ({items:[]});',
  'export const manageSandbox = async () => {};',
  'export const rerunCycle = async () => ({repository:"owner/repo", branch:"main", sandboxId:"sandbox_test", exitCode:0, log:"ok", afterRun:"keep", lifecycleStatus:"kept"});',
  'export const runCycle = async () => ({repository:"owner/repo", branch:"main", sandboxId:"sandbox_test", exitCode:0, log:"ok", afterRun:"keep", lifecycleStatus:"kept"});',
].join("\n");
const authURL = asModule(readFileSync(resolve("lib/mcp-auth.ts"), "utf8"));
const stubURL = asModule(stub);
const mcpJS = ts.transpileModule(readFileSync(resolve("lib/mcp.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
  .replace(/from ["']\.\/daytona["']/g, "from " + JSON.stringify(stubURL))
  .replace(/from ["']\.\/mcp-auth["']/g, "from " + JSON.stringify(authURL));
const { handleMcpRequest } = await import("data:text/javascript;base64," + Buffer.from(mcpJS).toString("base64"));
const token = "a".repeat(40);
async function rpc(name, auth, args = {}) {
  const response = await handleMcpRequest(new Request("https://daytona.example/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }));
  return response.json();
}
const ops = [
  ["list_sandboxes", {}],
  ["get_sandbox", { sandbox_id: "sandbox_test" }],
  ["manage_sandbox", { sandbox_id: "sandbox_test", action: "stop" }],
  ["configure_sandbox", { sandbox_id: "sandbox_test", setting: "auto_stop", minutes: 10 }],
  ["destroy_sandbox", { sandbox_id: "sandbox_test" }],
  ["rerun_cycle", { sandbox_id: "sandbox_test" }],
  ["run_cycle", { repository: "owner/repo" }],
];
test("all sandbox tools require bearer with Env Store configured", async () => {
  const oldMachine = process.env.PAMA_ENV_STORE_TOKEN;
  const oldCaller = process.env.PAMA_ENV_STORE_MCP_AUTH_TOKEN;
  try {
    process.env.PAMA_ENV_STORE_TOKEN = "pes_dummy_server_side_only";
    process.env.PAMA_ENV_STORE_MCP_AUTH_TOKEN = token;
    for (const [name, args] of ops) {
      const denied = await rpc(name, null, args);
      assert.equal(denied.result.isError, true, "denied: " + name);
      assert.match(denied.result.structuredContent.error, /Authenticated MCP caller required/);
      const authorized = await rpc(name, "Bearer " + token, args);
      assert.equal(authorized.result.isError, false, "allowed: " + name);
    }
  } finally {
    if (oldMachine === undefined) delete process.env.PAMA_ENV_STORE_TOKEN; else process.env.PAMA_ENV_STORE_TOKEN = oldMachine;
    if (oldCaller === undefined) delete process.env.PAMA_ENV_STORE_MCP_AUTH_TOKEN; else process.env.PAMA_ENV_STORE_MCP_AUTH_TOKEN = oldCaller;
  }
});
test("partially configured integration fails closed", async () => {
  const oldURL = process.env.PAMA_ENV_STORE_URL;
  const oldCaller = process.env.PAMA_ENV_STORE_MCP_AUTH_TOKEN;
  try {
    process.env.PAMA_ENV_STORE_URL = "https://env.example";
    delete process.env.PAMA_ENV_STORE_MCP_AUTH_TOKEN;
    assert.equal((await rpc("list_sandboxes", null)).result.isError, true);
  } finally {
    if (oldURL === undefined) delete process.env.PAMA_ENV_STORE_URL; else process.env.PAMA_ENV_STORE_URL = oldURL;
    if (oldCaller === undefined) delete process.env.PAMA_ENV_STORE_MCP_AUTH_TOKEN; else process.env.PAMA_ENV_STORE_MCP_AUTH_TOKEN = oldCaller;
  }
});
