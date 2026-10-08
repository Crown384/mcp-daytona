import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

// Exercise a genuine JSON-RPC tools/call -> rerunCycle -> executeRunner chain.
// Only the network-facing Daytona transport and GitHub App are mocked.
const transpile = (source) => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
}}).outputText;
const moduleUrl = (js) => "data:text/javascript;base64," + Buffer.from(js).toString("base64");
const compile = (source, imports = {}) => {
  let js = transpile(source);
  for (const [from, to] of Object.entries(imports)) {
    js = js.replaceAll('from "' + from + '"', 'from "' + to + '"');
  }
  return moduleUrl(js);
};
const config = compile('export function getConfig(){return {daytonaApiKey:"test-key",daytonaApiUrl:"https://api.daytona.example"};}');
const github = compile([
  'export function normalizeRepository(name){return name;}',
  'export async function getRepositoryCredentials(repository){return {repository,token:"dummy",username:"bot",identityName:"bot",identityEmail:"bot@example.com"};}',
].join("\n"));
const runner = compile('export const RUNNER_SCRIPT="echo fake-sandbox-command";');
const env = compile(readFileSync(resolve("lib/env-store.ts"), "utf8"));
const auth = compile(readFileSync(resolve("lib/mcp-auth.ts"), "utf8"));
const daytona = compile(readFileSync(resolve("lib/daytona.ts"), "utf8"), {
  "./config": config, "./github-app": github, "./runner": runner, "./env-store": env,
});
const mcp = compile(readFileSync(resolve("lib/mcp.ts"), "utf8"), {
  "./daytona": daytona, "./mcp-auth": auth,
});
const { handleMcpRequest } = await import(mcp);

const dummy = "dev:dummy-PRIVATE_FRAGMENTS_CANNOT_LEAK";
test("malformed HTTP 200 toolbox payload yields sanitized MCP error", async () => {
  const originalFetch = globalThis.fetch;
  const oldToken = process.env.PAMA_ENV_STORE_MCP_AUTH_TOKEN;
  const oldEnv = process.env.PAMA_ENV_STORE_URL;
  const oldMachine = process.env.PAMA_ENV_STORE_TOKEN;
  try {
    // No Env Store secrets are configured; only dummy bytes are injected in
    // a mocked malformed upstream response to reproduce the QA disclosure.
    delete process.env.PAMA_ENV_STORE_MCP_AUTH_TOKEN;
    delete process.env.PAMA_ENV_STORE_URL;
    delete process.env.PAMA_ENV_STORE_TOKEN;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/sandbox/fake-sandbox")) {
        return Response.json({
          id: "fake-sandbox", state: "started",
          labels: { "managed-by": "mcp-daytona", repository: "owner/repo", branch: "main" },
        });
      }
      if (String(url).includes("/process/execute")) {
        return new Response('{"exitCode":0,"result":' + dummy + ',"broken":"json"}', {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      throw Error("Unexpected URL in mock: " + String(url));
    };
    const request = new Request("https://daytona.example/mcp", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "rerun_cycle", arguments: {
          sandbox_id: "fake-sandbox", sync_mode: "none", after_run: "keep",
        }},
      }),
    });
    const rpc = await (await handleMcpRequest(request)).json();
    assert.equal(rpc.result.isError, true);
    assert.match(JSON.stringify(rpc), /Daytona runner response was invalid/);
    assert.equal(JSON.stringify(rpc).includes(dummy), false);
    assert.equal(JSON.stringify(rpc).includes("dev:dummy-PRIVATE"), false);
    assert.equal(JSON.stringify(rpc).includes("CANNOT_LEAK"), false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [
      ["PAMA_ENV_STORE_MCP_AUTH_TOKEN",oldToken],
      ["PAMA_ENV_STORE_URL",oldEnv],
      ["PAMA_ENV_STORE_TOKEN",oldMachine],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
