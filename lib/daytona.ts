import { getConfig } from "./config";
import { RUNNER_SCRIPT } from "./runner";

const DAYTONA_TOOLBOX_URL = "https://proxy.app.daytona.io/toolbox";
const MAX_LOG_CHARS = 40_000;
const MANAGED_BY_KEY = "managed-by";
const MANAGED_BY_VALUE = "mcp-daytona";

type JsonRecord = Record<string, unknown>;

export type AfterRun = "delete" | "keep" | "stop" | "pause";
export type SyncMode = "reset" | "none";
export type SandboxSnapshot =
  | "daytona-small"
  | "daytona-medium"
  | "daytona-large"
  | "daytona-vm-small"
  | "daytona-vm-medium"
  | "daytona-vm-large";
export type SandboxAction = "start" | "stop" | "pause" | "recover";
export type LifecycleSetting = "auto_stop" | "auto_pause" | "auto_delete";

export type RunCycleInput = Readonly<{
  repository: string;
  branch: string;
  timeoutSeconds: number;
  afterRun: AfterRun;
  snapshot: SandboxSnapshot;
  autoStopMinutes: number;
}>;

export type RerunCycleInput = Readonly<{
  sandboxId: string;
  timeoutSeconds: number;
  syncMode: SyncMode;
  afterRun: AfterRun;
}>;

export type CycleResult = Readonly<{
  repository: string;
  branch: string;
  sandboxId: string;
  exitCode: number;
  log: string;
  afterRun: AfterRun;
  lifecycleStatus: "completed" | "kept" | "failed";
  lifecycleError?: string;
}>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const config = getConfig();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${config.daytonaApiKey}`);
  const response = await fetch(`${config.daytonaApiUrl}${path}`, { ...init, headers });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Daytona request ${path} failed (${response.status}): ${text.slice(0, 1_000)}`);
  }
  return response;
}

async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await request(path, init);
  const text = await response.text();
  if (!text) return {};
  const value: unknown = JSON.parse(text);
  return value;
}

function truncateLog(log: string): string {
  if (log.length <= MAX_LOG_CHARS) return log;
  const head = log.slice(0, 5_000);
  const tail = log.slice(-(MAX_LOG_CHARS - 5_000));
  return `${head}\n\n... log truncated ...\n\n${tail}`;
}

function labelsOf(value: unknown): JsonRecord | undefined {
  if (!isRecord(value) || !isRecord(value.labels)) return undefined;
  return value.labels;
}

function isManagedSandbox(value: unknown): boolean {
  return labelsOf(value)?.[MANAGED_BY_KEY] === MANAGED_BY_VALUE;
}

function managedContext(value: unknown): { repository: string; branch: string } {
  const labels = labelsOf(value);
  const repository = labels?.repository;
  const branch = labels?.branch;
  if (typeof repository !== "string" || typeof branch !== "string") {
    throw new Error("Managed sandbox is missing repository or branch labels");
  }
  return { repository, branch };
}

async function getManagedSandboxRaw(sandboxId: string): Promise<unknown> {
  const sandbox = await requestJson(`/sandbox/${encodeURIComponent(sandboxId)}`);
  if (!isManagedSandbox(sandbox)) throw new Error("Sandbox is not managed by mcp-daytona");
  return sandbox;
}

async function labelSandbox(sandboxId: string, repository: string, branch: string): Promise<void> {
  await request(`/sandbox/${encodeURIComponent(sandboxId)}/labels`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ labels: { [MANAGED_BY_KEY]: MANAGED_BY_VALUE, repository, branch } }),
  });
}

async function createSandbox(input: RunCycleInput): Promise<string> {
  const config = getConfig();
  const value = await requestJson("/sandbox", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      target: config.daytonaTarget,
      snapshot: input.snapshot,
      ephemeral: input.afterRun === "delete",
      autoStopInterval: input.autoStopMinutes,
      ...(input.afterRun === "delete" ? {} : { autoDeleteInterval: -1 }),
    }),
  });

  if (!isRecord(value) || typeof value.id !== "string" || !value.id) {
    throw new Error("Daytona sandbox creation response did not include an id");
  }

  try {
    await labelSandbox(value.id, input.repository, input.branch);
  } catch (error) {
    await request(`/sandbox/${encodeURIComponent(value.id)}`, { method: "DELETE" }).catch(() => undefined);
    throw error;
  }
  return value.id;
}

async function executeRunner(
  sandboxId: string,
  action: "fresh" | "rerun",
  timeoutSeconds: number,
  repository?: string,
  branch?: string,
  syncMode: SyncMode = "reset",
): Promise<{ exitCode: number; log: string }> {
  const config = getConfig();
  const encodedScript = btoa(RUNNER_SCRIPT);
  const envs: Record<string, string> = {
    GITHUB_TOKEN: config.githubToken,
    GITHUB_OWNER: config.githubOwner,
    ACTION: action,
    SYNC_MODE: syncMode,
  };
  if (repository) envs.REPOSITORY = repository;
  if (branch) envs.BRANCH = branch;

  const response = await fetch(`${DAYTONA_TOOLBOX_URL}/${encodeURIComponent(sandboxId)}/process/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.daytonaApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ command: `printf '%s' '${encodedScript}' | base64 -d | bash`, cwd: ".", envs, timeout: timeoutSeconds }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Daytona runner execution failed (${response.status}): ${text.slice(0, 1_000)}`);

  const value: unknown = text ? JSON.parse(text) : {};
  if (!isRecord(value) || typeof value.exitCode !== "number" || typeof value.result !== "string") {
    throw new Error("Daytona runner response was missing exitCode or result");
  }
  return { exitCode: value.exitCode, log: truncateLog(value.result) };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function ensureStarted(sandboxId: string, sandbox: unknown): Promise<void> {
  if (isRecord(sandbox) && sandbox.state === "started") return;
  await request(`/sandbox/${encodeURIComponent(sandboxId)}/start`, { method: "POST" });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const current = await getManagedSandboxRaw(sandboxId);
    if (isRecord(current) && current.state === "started") return;
    await sleep(1_000);
  }
  throw new Error(`Sandbox ${sandboxId} did not reach started state within 60 seconds`);
}

async function applyAfterRun(sandboxId: string, afterRun: AfterRun): Promise<Pick<CycleResult, "lifecycleStatus" | "lifecycleError">> {
  if (afterRun === "keep") return { lifecycleStatus: "kept" };

  try {
    if (afterRun === "delete") {
      await request(`/sandbox/${encodeURIComponent(sandboxId)}`, { method: "DELETE" });
    } else {
      await request(`/sandbox/${encodeURIComponent(sandboxId)}/${afterRun}`, { method: "POST" });
    }
    return { lifecycleStatus: "completed" };
  } catch (error) {
    return { lifecycleStatus: "failed", lifecycleError: errorMessage(error) };
  }
}

function filterManagedList(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter(isManagedSandbox);
  if (!isRecord(value)) return [];

  for (const key of ["items", "sandboxes", "data"] as const) {
    const items = value[key];
    if (Array.isArray(items)) return { ...value, [key]: items.filter(isManagedSandbox) };
  }
  return [];
}

export async function runCycle(input: RunCycleInput): Promise<CycleResult> {
  const sandboxId = await createSandbox(input);
  let execution: { exitCode: number; log: string };

  try {
    execution = await executeRunner(sandboxId, "fresh", input.timeoutSeconds, input.repository, input.branch);
  } catch (error) {
    const lifecycle = await applyAfterRun(sandboxId, input.afterRun);
    const suffix = lifecycle.lifecycleError ? ` Lifecycle action also failed: ${lifecycle.lifecycleError}` : "";
    throw new Error(`${errorMessage(error)}${suffix}`);
  }

  const lifecycle = await applyAfterRun(sandboxId, input.afterRun);
  return {
    repository: input.repository,
    branch: input.branch,
    sandboxId,
    exitCode: execution.exitCode,
    log: execution.log,
    afterRun: input.afterRun,
    ...lifecycle,
  };
}

export async function rerunCycle(input: RerunCycleInput): Promise<CycleResult> {
  const sandbox = await getManagedSandboxRaw(input.sandboxId);
  const context = managedContext(sandbox);
  await ensureStarted(input.sandboxId, sandbox);
  const execution = await executeRunner(input.sandboxId, "rerun", input.timeoutSeconds, undefined, undefined, input.syncMode);
  const lifecycle = await applyAfterRun(input.sandboxId, input.afterRun);
  return { ...context, sandboxId: input.sandboxId, exitCode: execution.exitCode, log: execution.log, afterRun: input.afterRun, ...lifecycle };
}

export async function listManagedSandboxes(): Promise<unknown> {
  return filterManagedList(await requestJson("/sandbox"));
}

export async function getManagedSandbox(sandboxId: string): Promise<unknown> {
  return getManagedSandboxRaw(sandboxId);
}

export async function manageSandbox(sandboxId: string, action: SandboxAction): Promise<void> {
  await getManagedSandboxRaw(sandboxId);
  await request(`/sandbox/${encodeURIComponent(sandboxId)}/${action}`, { method: "POST" });
}

export async function configureSandbox(sandboxId: string, setting: LifecycleSetting, minutes: number): Promise<void> {
  await getManagedSandboxRaw(sandboxId);
  const pathBySetting: Record<LifecycleSetting, string> = {
    auto_stop: "autostop",
    auto_pause: "autopause",
    auto_delete: "autodelete",
  };
  await request(`/sandbox/${encodeURIComponent(sandboxId)}/${pathBySetting[setting]}/${minutes}`, { method: "POST" });
}

export async function destroySandbox(sandboxId: string): Promise<void> {
  await getManagedSandboxRaw(sandboxId);
  await request(`/sandbox/${encodeURIComponent(sandboxId)}`, { method: "DELETE" });
}
