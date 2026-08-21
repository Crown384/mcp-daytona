import { runCycle } from "./daytona";

const CURRENT_PROTOCOL = "2026-07-28";
const LEGACY_PROTOCOL = "2025-11-25";
const SERVER_INFO = { name: "mcp-daytona", version: "0.1.0" } as const;
const SERVER_INSTRUCTIONS =
  "Use run_cycle only after code changes are already pushed to GitHub. It creates an isolated Daytona sandbox, checks the selected branch, and never edits implementation source code.";
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/;

type JsonRpcId = string | number | null;
type JsonRecord = Record<string, unknown>;

type RpcRequest = Readonly<{
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}>;

const RUN_CYCLE_TOOL = {
  name: "run_cycle",
  title: "Run Daytona repository cycle",
  description:
    "Use this when code is already pushed to GitHub and you need a fresh Daytona sandbox to clone an allowed repository branch, install dependencies, run configured checks, and push the checked HEAD back to the same branch. Do not use this tool to edit source code.",
  inputSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: "Repository name only, without the GitHub owner. Must be in ALLOWED_GITHUB_REPOS.",
      },
      branch: {
        type: "string",
        description: "Existing GitHub branch to check. Defaults to main.",
        default: "main",
      },
      timeout_seconds: {
        type: "integer",
        minimum: 60,
        maximum: 3600,
        default: 1200,
        description: "Maximum time for the single Daytona runner process.",
      },
    },
    required: ["repository"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      repository: { type: "string" },
      branch: { type: "string" },
      sandboxId: { type: "string" },
      exitCode: { type: "integer" },
      log: { type: "string" },
      cleanup: { type: "string", enum: ["deleted", "delete_failed"] },
      cleanupError: { type: "string" },
    },
    required: ["repository", "branch", "sandboxId", "exitCode", "log", "cleanup"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
} as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequest(value: unknown): RpcRequest | undefined {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
    return undefined;
  }

  if ("id" in value && value.id !== null && typeof value.id !== "string" && typeof value.id !== "number") {
    return undefined;
  }

  return {
    ...(value.id === undefined ? {} : { id: value.id as JsonRpcId }),
    method: value.method,
    ...(value.params === undefined ? {} : { params: value.params }),
  };
}

function rpcResponse(id: JsonRpcId, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: JsonRpcId, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolError(id: JsonRpcId, message: string): Response {
  return rpcResponse(id, {
    resultType: "complete",
    content: [{ type: "text", text: message }],
    isError: true,
  });
}

function parseRunCycleInput(value: unknown): { repository: string; branch: string; timeoutSeconds: number } {
  if (!isRecord(value) || typeof value.repository !== "string" || !REPOSITORY_PATTERN.test(value.repository)) {
    throw new Error("repository must be a valid repository name");
  }

  const branch = typeof value.branch === "string" ? value.branch : "main";
  if (!BRANCH_PATTERN.test(branch) || branch.includes("..") || branch.startsWith("/") || branch.endsWith("/")) {
    throw new Error("branch contains invalid characters");
  }

  const timeoutSeconds = value.timeout_seconds === undefined ? 1200 : value.timeout_seconds;
  if (!Number.isInteger(timeoutSeconds) || typeof timeoutSeconds !== "number" || timeoutSeconds < 60 || timeoutSeconds > 3600) {
    throw new Error("timeout_seconds must be an integer between 60 and 3600");
  }

  return { repository: value.repository, branch, timeoutSeconds };
}

function initializeResult(params: unknown): JsonRecord {
  const requestedVersion = isRecord(params) && typeof params.protocolVersion === "string"
    ? params.protocolVersion
    : LEGACY_PROTOCOL;

  return {
    protocolVersion: requestedVersion,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions: SERVER_INSTRUCTIONS,
  };
}

function discoveryResult(): JsonRecord {
  return {
    resultType: "complete",
    supportedVersions: [CURRENT_PROTOCOL, LEGACY_PROTOCOL],
    capabilities: { tools: {} },
    _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
    instructions: SERVER_INSTRUCTIONS,
    ttlMs: 3_600_000,
    cacheScope: "public",
  };
}

async function callTool(id: JsonRpcId, params: unknown, headerToolName: string | null): Promise<Response> {
  if (!isRecord(params)) {
    return toolError(id, "tools/call requires an object params value");
  }

  const toolName = typeof params.name === "string" ? params.name : headerToolName;
  if (toolName !== RUN_CYCLE_TOOL.name) {
    return toolError(id, `Unknown tool: ${toolName ?? "missing"}`);
  }

  try {
    const input = parseRunCycleInput(params.arguments);
    const result = await runCycle(input);
    const failed = result.exitCode !== 0 || result.cleanup === "delete_failed";
    const summary = failed
      ? `Daytona cycle failed for ${result.repository}@${result.branch} with exit code ${result.exitCode}.`
      : `Daytona cycle passed for ${result.repository}@${result.branch}.`;

    return rpcResponse(id, {
      resultType: "complete",
      content: [{ type: "text", text: summary }],
      structuredContent: result,
      isError: failed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(id, message);
  }
}

export async function handleMcpRequest(request: Request): Promise<Response> {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }

  const rpc = parseRequest(payload);
  if (!rpc) {
    return rpcError(null, -32600, "Invalid Request");
  }

  if (rpc.id === undefined) {
    return new Response(null, { status: 202 });
  }

  switch (rpc.method) {
    case "initialize":
      return rpcResponse(rpc.id, initializeResult(rpc.params));
    case "server/discover":
      return rpcResponse(rpc.id, discoveryResult());
    case "tools/list":
      return rpcResponse(rpc.id, {
        resultType: "complete",
        tools: [RUN_CYCLE_TOOL],
        ttlMs: 3_600_000,
        cacheScope: "public",
      });
    case "tools/call":
      return callTool(rpc.id, rpc.params, request.headers.get("Mcp-Name"));
    default:
      return rpcError(rpc.id, -32601, `Method not found: ${rpc.method}`);
  }
}
