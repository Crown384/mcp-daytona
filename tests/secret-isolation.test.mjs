import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

function asModule(source) {
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return "data:text/javascript;base64," + Buffer.from(code).toString("base64");
}
const envURL = asModule(readFileSync(resolve("lib/env-store.ts"), "utf8"));
const { assertTrustedSecretExecution } = await import(envURL);
const configURL = asModule('export function getConfig(){return {daytonaApiKey:"dummy",daytonaApiUrl:"https://api.test"};}');
const githubURL = asModule('export function normalizeRepository(r){return r;} export async function getRepositoryCredentials(){throw Error("credentials must not be requested");}');
const runnerURL = asModule('export const RUNNER_SCRIPT = "echo dummy";');
let code = ts.transpileModule(readFileSync(resolve("lib/daytona.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
  .replace(/from ["']\.\/config["']/g, "from " + JSON.stringify(configURL))
  .replace(/from ["']\.\/github-app["']/g, "from " + JSON.stringify(githubURL))
  .replace(/from ["']\.\/runner["']/g, "from " + JSON.stringify(runnerURL))
  .replace(/from ["']\.\/env-store["']/g, "from " + JSON.stringify(envURL));
const { runCycle, rerunCycle } = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));

async function scopedPolicy(policy, operation) {
  const previous = process.env.PAMA_ENV_STORE_TRUSTED_REPOS;
  const previousFetch = globalThis.fetch;
  if (policy === null) delete process.env.PAMA_ENV_STORE_TRUSTED_REPOS;
  else process.env.PAMA_ENV_STORE_TRUSTED_REPOS = policy;
  try { await operation(); }
  finally {
    if (previous === undefined) delete process.env.PAMA_ENV_STORE_TRUSTED_REPOS;
    else process.env.PAMA_ENV_STORE_TRUSTED_REPOS = previous;
    globalThis.fetch = previousFetch;
  }
}

test("secret-bearing executions require explicit exact trusted repository matches", async () => {
  await scopedPolicy(null, () => {
    assert.throws(() => assertTrustedSecretExecution("owner/repo", "delete"), /not configured/);
  });
  await scopedPolicy("Owner/Repo, another/service", () => {
    assert.doesNotThrow(() => assertTrustedSecretExecution("owner/repo", "delete"));
    assert.doesNotThrow(() => assertTrustedSecretExecution("Another/Service", "delete"));
    assert.throws(() => assertTrustedSecretExecution("owner/repository", "delete"), /not trusted/);
    assert.throws(() => assertTrustedSecretExecution("evil/repo", "delete"), /not trusted/);
  });
  await scopedPolicy("owner/*", () => {
    assert.throws(() => assertTrustedSecretExecution("owner/repo", "delete"), /policy is invalid/);
  });
  await scopedPolicy("owner/repo,", () => {
    assert.throws(() => assertTrustedSecretExecution("owner/repo", "delete"), /policy is invalid/);
  });
});

test("secret-bearing executions may not preserve a sandbox", async () => {
  await scopedPolicy("owner/repo", () => {
    for (const lifecycle of ["keep", "pause", "stop"]) {
      assert.throws(() => assertTrustedSecretExecution("owner/repo", lifecycle), /requires after_run=delete/);
    }
    assert.doesNotThrow(() => assertTrustedSecretExecution("owner/repo", "delete"));
  });
});

const freshInput = {
  repository: "owner/repo", branch: "staging", timeoutSeconds: 120,
  afterRun: "delete", snapshot: "daytona-small", autoStopMinutes: 15,
  workingPath: ".", envStore: { project: "track", environment: "staging" },
};

test("actual runCycle rejects denied policies before secrets, GitHub auth or Daytona provisioning", async () => {
  await scopedPolicy("trusted/only", async () => {
    let outbound = 0;
    globalThis.fetch = async () => { outbound++; throw Error("unwanted outbound request"); };
    await assert.rejects(runCycle(freshInput), /not trusted/);
    assert.equal(outbound, 0);
  });
  await scopedPolicy("owner/repo", async () => {
    let outbound = 0;
    globalThis.fetch = async () => { outbound++; throw Error("unwanted outbound request"); };
    await assert.rejects(runCycle({ ...freshInput, afterRun: "keep" }), /requires after_run=delete/);
    assert.equal(outbound, 0);
  });
});

test("actual rerunCycle validates sandbox label identity before retrieving secrets", async () => {
  await scopedPolicy("trusted/only", async () => {
    let outbound = 0;
    globalThis.fetch = async (url) => {
      outbound++;
      assert.match(url, /\/sandbox\/sandbox_test$/);
      return Response.json({ labels: { "managed-by": "mcp-daytona", repository: "owner/repo", branch: "staging" } });
    };
    const params = {
      sandboxId: "sandbox_test", timeoutSeconds: 120, syncMode: "reset",
      afterRun: "delete", workingPath: ".", envStore: { project: "track", environment: "staging" },
    };
    await assert.rejects(rerunCycle(params), /not trusted/);
    assert.equal(outbound, 1, "only a sandbox metadata lookup is allowed");
  });
  await scopedPolicy("owner/repo", async () => {
    let outbound = 0;
    globalThis.fetch = async () => {
      outbound++;
      return Response.json({ labels: { "managed-by": "mcp-daytona", repository: "owner/repo", branch: "staging" } });
    };
    await assert.rejects(rerunCycle({
      sandboxId: "sandbox_test", timeoutSeconds: 120, syncMode: "reset",
      afterRun: "keep", workingPath: ".", envStore: { project: "track", environment: "production" },
    }), /requires after_run=delete/);
    assert.equal(outbound, 1, "no secret lookup or runner execution");
  });
});
