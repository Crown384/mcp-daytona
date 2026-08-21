import { assertAllowedRepository, getConfig } from "./config";
import { RUNNER_SCRIPT } from "./runner";

const DAYTONA_TOOLBOX_URL = "https://proxy.app.daytona.io/toolbox";
const MAX_LOG_CHARS = 40_000;

type JsonRecord = Record<string, unknown>;

export type RunCycleInput = Readonly<{
  repository: string;
  branch: string;
  timeoutSeconds: number;
}>;

export type RunCycleResult = Readonly<{
  repository: string;
  branch: string;
  sandboxId: string;
  exitCode: number;
  log: string;
  cleanup: "deleted" | "delete_failed";
  cleanupError?: string;
}>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJson(response: Response, label: string): Promise<JsonRecord> {
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${label} failed (${response.status}): ${text.slice(0, 1_000)}`);
  }

  if (!text) {
    return {};
  }

  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) {
    throw new Error(`${label} returned an invalid JSON object`);
  }

  return value;
}

function truncateLog(log: string): string {
  if (log.length <= MAX_LOG_CHARS) {
    return log;
  }

  const head = log.slice(0, 5_000);
  const tail = log.slice(-(MAX_LOG_CHARS - 5_000));
  return `${head}\n\n... log truncated ...\n\n${tail}`;
}

async function createSandbox(): Promise<string> {
  const config = getConfig();
  const response = await fetch(`${config.daytonaApiUrl}/sandbox`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.daytonaApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      target: config.daytonaTarget,
      snapshot: "daytona-medium",
      ephemeral: true,
      autoStopInterval: 75,
    }),
  });
  const json = await readJson(response, "Daytona sandbox creation");

  if (typeof json.id !== "string" || !json.id) {
    throw new Error("Daytona sandbox creation response did not include an id");
  }

  return json.id;
}

async function executeRunner(sandboxId: string, input: RunCycleInput): Promise<{ exitCode: number; log: string }> {
  const config = getConfig();
  const encodedScript = btoa(RUNNER_SCRIPT);
  const response = await fetch(`${DAYTONA_TOOLBOX_URL}/${encodeURIComponent(sandboxId)}/process/execute`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.daytonaApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      command: `printf '%s' '${encodedScript}' | base64 -d | bash`,
      cwd: ".",
      envs: {
        GITHUB_TOKEN: config.githubToken,
        GITHUB_OWNER: config.githubOwner,
        REPOSITORY: input.repository,
        BRANCH: input.branch,
      },
      timeout: input.timeoutSeconds,
    }),
  });
  const json = await readJson(response, "Daytona runner execution");

  if (typeof json.exitCode !== "number" || typeof json.result !== "string") {
    throw new Error("Daytona runner response was missing exitCode or result");
  }

  return { exitCode: json.exitCode, log: truncateLog(json.result) };
}

async function deleteSandbox(sandboxId: string): Promise<string | undefined> {
  const config = getConfig();

  try {
    const response = await fetch(`${config.daytonaApiUrl}/sandbox/${encodeURIComponent(sandboxId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${config.daytonaApiKey}` },
    });

    if (!response.ok) {
      return `Daytona sandbox deletion failed (${response.status})`;
    }
  } catch (error) {
    return errorMessage(error);
  }

  return undefined;
}

export async function runCycle(input: RunCycleInput): Promise<RunCycleResult> {
  const config = getConfig();
  assertAllowedRepository(config, input.repository);

  const sandboxId = await createSandbox();
  let execution: { exitCode: number; log: string } | undefined;
  let executionError: unknown;

  try {
    execution = await executeRunner(sandboxId, input);
  } catch (error) {
    executionError = error;
  }

  const cleanupError = await deleteSandbox(sandboxId);

  if (executionError) {
    const cleanupSuffix = cleanupError ? ` Cleanup also failed: ${cleanupError}` : "";
    throw new Error(`${errorMessage(executionError)}${cleanupSuffix}`);
  }

  if (!execution) {
    throw new Error("Daytona runner did not return an execution result");
  }

  return {
    repository: input.repository,
    branch: input.branch,
    sandboxId,
    exitCode: execution.exitCode,
    log: execution.log,
    cleanup: cleanupError ? "delete_failed" : "deleted",
    ...(cleanupError ? { cleanupError } : {}),
  };
}
