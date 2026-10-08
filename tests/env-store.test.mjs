import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";
import ts from "typescript";

const input = readFileSync(resolve("lib/env-store.ts"), "utf8");
const code = ts.transpileModule(input, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { loadEnvStoreValues, redactEnvStoreOutput } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);

const names = ["PAMA_ENV_STORE_URL", "PAMA_ENV_STORE_TOKEN", "PAMA_ENV_STORE_ALLOW_PRODUCTION"];
async function withContext(callback) {
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  process.env.PAMA_ENV_STORE_URL = "https://env.pama.company";
  process.env.PAMA_ENV_STORE_TOKEN = "pes_machine_private_token";
  delete process.env.PAMA_ENV_STORE_ALLOW_PRODUCTION;
  try { await callback(); }
  finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    globalThis.fetch = previousFetch;
  }
}
const staging = { project: "track", environment: "staging" };
function response(values, project = "track", environment = "staging") {
  return new Response(JSON.stringify({ project: { slug: project }, environment, values }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}
test("trusted backend fetches scoped staging values without exposing credentials", async () => {
  await withContext(async () => {
    let called = false;
    globalThis.fetch = async (url, options) => {
      called = true;
      assert.equal(url, "https://env.pama.company/api/projects/track/env/staging");
      assert.equal(options.headers.Authorization, "Bearer pes_machine_private_token");
      assert.equal(options.cache, "no-store");
      assert.equal(options.redirect, "error");
      return response({ CONVEX_DEPLOY_KEY: "dev:private_deploy_key", API_URL: "https://safe.example" });
    };
    const result = await loadEnvStoreValues(staging);
    assert.equal(called, true);
    assert.equal(result.CONVEX_DEPLOY_KEY, "dev:private_deploy_key");
    assert.equal(result.API_URL, "https://safe.example");
  });
});
test("denies production unless server operator opts in", async () => {
  await withContext(async () => {
    globalThis.fetch = async () => { throw new Error("must not fetch"); };
    await assert.rejects(loadEnvStoreValues({ project: "track", environment: "production" }), /Production Env Store access is disabled/);
  });
});
test("production is allowed only with explicit opt-in and token scope", async () => {
  await withContext(async () => {
    process.env.PAMA_ENV_STORE_ALLOW_PRODUCTION = "true";
    globalThis.fetch = async (url) => {
      assert.match(url, /env\/production$/);
      return response({ RELEASE_TOKEN: "production-only" }, "track", "production");
    };
    assert.equal((await loadEnvStoreValues({ project: "track", environment: "production" })).RELEASE_TOKEN, "production-only");
  });
});
test("rejects reserved envs that could override Daytona's runner", async () => {
  await withContext(async () => {
    for (const key of ["GITHUB_TOKEN", "ACTION", "COMMAND", "BASH_ENV", "LD_PRELOAD", "GIT_CONFIG_COUNT"]) {
      globalThis.fetch = async () => response({ [key]: "malicious" });
      await assert.rejects(loadEnvStoreValues(staging), /unsafe environment variable/);
    }
  });
});
test("rejects cross-project and cross-environment responses", async () => {
  await withContext(async () => {
    globalThis.fetch = async () => response({ FOO: "secret" }, "other", "staging");
    await assert.rejects(loadEnvStoreValues(staging), /mismatched project/);
    globalThis.fetch = async () => response({ FOO: "secret" }, "track", "production");
    await assert.rejects(loadEnvStoreValues(staging), /mismatched project/);
  });
});
test("rejects malformed payloads and oversized values", async () => {
  await withContext(async () => {
    globalThis.fetch = async () => response({ GOOD: 42 });
    await assert.rejects(loadEnvStoreValues(staging), /unsafe environment variable/);
    globalThis.fetch = async () => response({ GOOD: "x".repeat(16_385) });
    await assert.rejects(loadEnvStoreValues(staging), /unsafe environment variable/);
  });
});
test("fails closed for refused tokens and network errors", async () => {
  await withContext(async () => {
    globalThis.fetch = async () => new Response("secret should never leak", { status: 403 });
    await assert.rejects(loadEnvStoreValues(staging), /refused environment access/);
    globalThis.fetch = async () => { throw new Error("Authorization: Bearer pes_should_not_leak"); };
    await assert.rejects(loadEnvStoreValues(staging), (error) => !error.message.includes("pes_should_not_leak"));
  });
});
test("validates HTTPS configured origin and requires a machine token", async () => {
  await withContext(async () => {
    process.env.PAMA_ENV_STORE_URL = "http://127.0.0.1:3333";
    await assert.rejects(loadEnvStoreValues(staging), /HTTPS origin/);
    process.env.PAMA_ENV_STORE_URL = "https://env.pama.company";
    delete process.env.PAMA_ENV_STORE_TOKEN;
    await assert.rejects(loadEnvStoreValues(staging), /machine access is not configured/);
  });
});
test("redacts raw and URL-encoded secret values from logs", () => {
  const values = { DEPLOY_KEY: "dev:tough-curlew-901|private123", EMPTY: "" };
  const logs = "key=dev:tough-curlew-901|private123 encoded=" + encodeURIComponent(values.DEPLOY_KEY);
  const sanitized = redactEnvStoreOutput(logs, values);
  assert.equal(sanitized, "key=[REDACTED] encoded=[REDACTED]");
  assert.equal(redactEnvStoreOutput("safe", values), "safe");
});
