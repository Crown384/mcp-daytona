import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";

// Exercise the real MCP JSON-RPC request handler with a mocked Daytona transport.
// This verifies the authentication boundary before any sandbox operation runs.
const authTS = readFileSync(resolve("lib/mcp-auth.ts"), "utf8");
const mcpTS = readFileSync(resolve("lib/mcp.ts"), "utf8");
function moduleURL(source) {
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  return "data:text/javascript;base64," + Buffer.from(js).toString("base64");
}
const mockDaytona = moduleURL(