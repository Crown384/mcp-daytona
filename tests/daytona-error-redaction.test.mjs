import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

function asModule(source) {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}
const configURL = asModule('export function getConfig(){ return { daytonaApiKey:"test", daytonaApiUrl:"https://api.example" }; }');
const githubURL = asModule('export function normalizeRepository(r){ return r; } export async function getRepositoryCredentials(){ return {}; }');
const runnerURL = asModule('export const RUNNER_SCRIPT = "echo test";');
const envURL = asModule(readFileSync(resolve("lib/env-store.ts"), "utf8"));
const input = readFileSync(resolve("lib/daytona.ts"), "utf8");
// Execute the real executeRunner implementation (not a copy) via in-memory
// module compilation and replace its external dependencies.
let js = ts.transpileModule(input, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
  .replace(/from ["']\.\/config["']/g, "from " + JSON.stringify(configURL))
  .replace(/from ["']\.\/github-app["']/g, "from " + JSON.stringify(githubURL))
  .replace(/from ["']\.\/runner["']/g, "from " + JSON.stringify(runnerURL))
  .replace(/from ["']\.\/env-store["']/g, "from " + JSON.stringify(envURL));
js += "\nexport { executeRunner };";
const { executeRunner } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const secret = "dev:tough-curlew-dummy|a-long-secret-that-must-not-be-leaked";
const runtimeEnv = { CONVEX_DEPLOY_KEY: secret };

async function invoke() {
  return executeRunner("fake-sandbox", "fresh", 120, {
    token:"dummy", username:"bot", identityName:"bot", identityEmail:"bot@example.com", repository:"owner/repo",
  }, "main", "reset", "echo test", ".", runtimeEnv);
}

test("Daytona HTTP failure never exposes partial secret across 1000-character boundary", async () => {
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("p".repeat(995) + secret + " other secret=" + secret, { status: 503 });
    await assert.rejects(invoke(), (error) => {
      assert.equal(error.message, "Daytona runner execution failed (HTTP 503)");
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes(secret.slice(0, 5)), false);
      assert.equal(error.message.includes(secret.slice(-8)), false);
      return true;
    });
  } finally { globalThis.fetch = oldFetch; }
});
test("success logs are redacted for raw and URL-encoded secrets", async () => {
  const oldFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({
      exitCode: 0,
      result: "raw=" + secret + " url=" + encodeURIComponent(secret),
    });
    const result = await invoke();
    assert.equal(result.exitCode, 0);
    assert.equal(result.log, "raw=[REDACTED] url=[REDACTED]");
  } finally { globalThis.fetch = oldFetch; }
});

test("HTTP 200 malformed toolbox JSON never leaks input through parser errors", async () => {
  const oldFetch = globalThis.fetch;
  const malformed = '{"exitCode":0,"result":' + secret + ',"other":"hidden"}';
  try {
    globalThis.fetch = async () => new Response(malformed, { status: 200, headers: { "Content-Type": "application/json" } });
    await assert.rejects(invoke(), (error) => {
      assert.equal(error.message, "Daytona runner response was invalid");
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes(secret.slice(0, 12)), false);
      assert.equal(error.message.includes(secret.slice(-12)), false);
      return true;
    });
  } finally { globalThis.fetch = oldFetch; }
});
