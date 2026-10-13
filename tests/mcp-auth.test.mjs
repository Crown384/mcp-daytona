import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

const input = readFileSync(resolve("lib/mcp-auth.ts"), "utf8");
const code = ts.transpileModule(input, { compilerOptions: {
  module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
} }).outputText;
const { authorizeEnvStoreCaller } = await import(
  "data:text/javascript;base64," + Buffer.from(code).toString("base64")
);
const token = "a".repeat(32) + "-token-for-authorized-mcp-caller";
test("unauthenticated secret-enabled MCP calls fail closed", async () => {
  const previous = process.env.PAMA_ENV_STORE_MCP_AUTH_TOKEN;
  try {
    delete process.env.PAMA_ENV_STORE_MCP_AUTH_TOKEN;
    assert.equal(await authorizeEnvStoreCaller("Bearer " + token), false);
    process.env.PAMA_ENV_STORE_MCP_AUTH_TOKEN = token;
    assert.equal(await authorizeEnvStoreCaller(null), false);
    assert.equal(await authorizeEnvStoreCaller("Bearer wrong"), false);
    assert.equal(await authorizeEnvStoreCaller("Bearer " + "x".repeat(64)), false);
    assert.equal(await authorizeEnvStoreCaller("Basic " + token), false);
    assert.equal(await authorizeEnvStoreCaller("Bearer " + token), true);
  } finally {
    if (previous === undefined) delete process.env.PAMA_ENV_STORE_MCP_AUTH_TOKEN;
    else process.env.PAMA_ENV_STORE_MCP_AUTH_TOKEN = previous;
  }
});
test("MCP call handler gates secret-enhanced operations on bearer", () => {
  const source = readFileSync(resolve("lib/mcp.ts"), "utf8");
  assert.match(source, /authenticateMcpCaller\(authorization,/);
  assert.match(source, /args\.env_store_project !== undefined/);
  assert.match(source, /request\.headers\.get\("Authorization"\)/);
});
