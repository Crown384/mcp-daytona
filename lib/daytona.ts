import { getConfig } from "./config";
import { getRepositoryCredentials, normalizeRepository, type RepositoryCredentials } from "./github-app";
import { RUNNER_SCRIPT } from "./runner";
import { assertTrustedSecretExecution, loadEnvStoreValues, redactEnvStoreOutput, type EnvStoreSelection } from "./env-store";

const DAYTONA_TOOLBOX_URL = "https://proxy.app.daytona.io/toolbox";
const MAX_LOG_CHARS = 40_000;
const MANAGED_BY_KEY = "managed-by";
const MANAGED_BY_VALUE = "mcp-daytona";
const CLIENT_OWNER_LABEL = "mcp-client-id";

/** Authenticated owner identity is supplied by the trusted MCP handler. */
type SandboxPrincipal = Readonly<{
  id: string;
  repositories: readonly string[];
  projects: readonly string[];
  environments: readonly ("staging" | "production")[];
}>;

function checkPrincipalScope(principal: SandboxPrincipal | undefined, repository: string, selection?: EnvStoreSelection): void {
  if (!principal) return;
  if (!principal.repositories.includes(repository.toLowerCase())) throw new Error("MCP principal cannot access repository");
  if (selection && (!principal.projects.includes(selection.project) ||
      !principal.environments.includes(selection.environment))) throw new Error("MCP principal cannot access project/environment");
}

const API_RETRY_ATTEMPTS = 10;
const RETRY_BASE_DELAY_MS = 750;

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
  command?: string;
  workingPath: string;
  envStore?: EnvStoreSelection;
}>;

export type RerunCycleInput = Readonly<{
  sandboxId: string;
  timeoutSeconds: number;
  syncMode: SyncMode;
  afterRun: AfterRun;
  command?: string;
  workingPath: string;
  envStore?: EnvStoreSelection;
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
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (!cause || typeof cause !== "object") return error.message;
  const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
  const message = "message" in cause && typeof cause.message === "string" ? cause.message : undefined;
  const detail = [code, message].filter(Boolean).join(": ");
  return detail ? `${error.message} (${detail})` : error.message;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function requestMethod(init: RequestInit): string {
  return (init.method ?? "GET").toUpperCase();
}

function isSafeRequestToRetry(init: RequestInit): boolean {
  return ["GET", "HEAD", "PUT", "DELETE"].includes(requestMethod(init));
}

function retryDelayMs(response: Response | undefined, attempt: number): number {
  const raw = response?.headers.get("retry-after-sandbox-create") ?? response?.headers.get("retry-after");
  const seconds = raw === null ? Number.NaN : Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(250, seconds * 1_000);
  return RETRY_BASE_DELAY_MS * attempt;
}

async function fetchWithRetry(url: string, init: RequestInit, label: string, allowRetry: boolean): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= API_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (!allowRetry || !isRetryableStatus(response.status) || attempt === API_RETRY_ATTEMPTS) return response;
      await sleep(retryDelayMs(response, attempt));
    } catch (error) {
      lastError = error;
      if (!allowRetry || attempt === API_RETRY_ATTEMPTS) {
        throw new Error(`${label} network request failed${allowRetry ? ` after ${attempt} attempts` : ""}: ${errorMessage(error)}`);
      }
      await sleep(retryDelayMs(undefined, attempt));
    }
  }

  throw new Error(`${label} network request failed after ${API_RETRY_ATTEMPTS} attempts: ${errorMessage(lastError)}`);
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const config = getConfig();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${config.daytonaApiKey}`);
  const response = await fetchWithRetry(
    `${config.daytonaApiUrl}${path}`,
    { ...init, headers },
    `Daytona request ${path}`,
    isSafeRequestToRetry(init),
  );

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

function isOwnedSandbox(value: unknown, principal?: SandboxPrincipal): boolean {
  if (!isManagedSandbox(value)) return false;
  if (!principal) return true;
  const labels = labelsOf(value);
  return labels?.[CLIENT_OWNER_LABEL] === principal.id &&
    typeof labels.repository === "string" &&
    principal.repositories.includes(labels.repository.toLowerCase());
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

async function getManagedSandboxRaw(sandboxId: string, principal?: SandboxPrincipal): Promise<unknown> {
  const sandbox = await requestJson(`/sandbox/${encodeURIComponent(sandboxId)}`);
  if (!isOwnedSandbox(sandbox, principal)) throw new Error("Sandbox is not accessible to MCP caller");
  return sandbox;
}

async function labelSandbox(sandboxId: string, repository: string, branch: string, principal?: SandboxPrincipal): Promise<void> {
  await request(`/sandbox/${encodeURIComponent(sandboxId)}/labels`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ labels: { [MANAGED_BY_KEY]: MANAGED_BY_VALUE, repository, branch,
      ...(principal ? { [CLIENT_OWNER_LABEL]: principal.id } : {}) } }),
  });
}

function newSandboxName(): string {
  return `mcp-daytona-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

async function tryRecoverSandbox(name: string): Promise<unknown | undefined> {
  const config = getConfig();
  try {
    const response = await fetch(`${config.daytonaApiUrl}/sandbox/${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${config.daytonaApiKey}` },
    });
    if (!response.ok) return undefined;
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return undefined;
  }
}

async function createSandboxRequest(input: RunCycleInput, name: string): Promise<unknown> {
  const config = getConfig();
  const url = `${config.daytonaApiUrl}/sandbox`;
  const body = JSON.stringify({
    name,
    snapshot: input.snapshot,
    ephemeral: input.afterRun === "delete",
    autoStopInterval: input.autoStopMinutes,
    ...(input.afterRun === "delete" ? {} : { autoDeleteInterval: -1 }),
  });
  let lastError: unknown;

  for (let attempt = 1; attempt <= API_RETRY_ATTEMPTS; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.daytonaApiKey}`, "Content-Type": "application/json" },
        body,
      });
    } catch (error) {
      lastError = error;
      const recovered = await tryRecoverSandbox(name);
      if (recovered) return recovered;
      if (attempt === API_RETRY_ATTEMPTS) break;
      await sleep(retryDelayMs(undefined, attempt));
      continue;
    }

    if (response.ok) {
      const text = await response.text();
      return text ? JSON.parse(text) : {};
    }

    const text = await response.text();
    lastError = new Error(`Daytona sandbox creation failed (${response.status}): ${text.slice(0, 1_000)}`);
    const recovered = await tryRecoverSandbox(name);
    if (recovered) return recovered;
    if (!isRetryableStatus(response.status)) throw lastError;
    if (attempt < API_RETRY_ATTEMPTS) await sleep(retryDelayMs(response, attempt));
  }

  throw new Error(`Daytona sandbox creation failed after ${API_RETRY_ATTEMPTS} attempts: ${errorMessage(lastError)}`);
}

async function createSandbox(input: RunCycleInput, principal?: SandboxPrincipal): Promise<string> {
  const value = await createSandboxRequest(input, newSandboxName());
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) {
    throw new Error("Daytona sandbox creation response did not include an id");
  }

  try {
    await labelSandbox(value.id, input.repository, input.branch, principal);
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
  credentials: RepositoryCredentials,
  branch?: string,
  syncMode: SyncMode = "reset",
  command?: string,
  workingPath = ".",
  runtimeEnv: Record<string, string> = {},
): Promise<{ exitCode: number; log: string }> {
  const config = getConfig();
  const encodedScript = btoa(RUNNER_SCRIPT);
  const envs: Record<string, string> = {
    ...runtimeEnv,
    GITHUB_TOKEN: credentials.token,
    GITHUB_USERNAME: credentials.username,
    GIT_IDENTITY_NAME: credentials.identityName,
    GIT_IDENTITY_EMAIL: credentials.identityEmail,
    ACTION: action,
    SYNC_MODE: syncMode,
    WORKING_PATH: workingPath,
  };
  if (action === "fresh") envs.REPOSITORY = credentials.repository;
  if (branch) envs.BRANCH = branch;
  if (command) envs.COMMAND = command;

  let response: Response;
  try {
    response = await fetch(`${DAYTONA_TOOLBOX_URL}/${encodeURIComponent(sandboxId)}/process/execute`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.daytonaApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ command: `printf '%s' '${encodedScript}' | base64 -d | bash`, cwd: ".", envs, timeout: timeoutSeconds }),
    });
  } catch (error) {
    throw new Error(`Daytona runner network request failed and was not retried because the command may already have started: ${redactEnvStoreOutput(errorMessage(error), runtimeEnv)}`);
  }

  // Never surface an upstream toolbox error body: it may include a partial,
  // transformed or truncated secret and cannot be reliably sanitized.
  // Discard it completely, keeping only the HTTP status for diagnostics.
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Daytona runner execution failed (HTTP ${response.status})`);
  }
  // SyntaxError from JSON.parse can include a fragment of the raw response.
  // Treat the entire successful-response body as untrusted: never let its text,
  // parse errors or read errors escape into an MCP tool result.
  let value: unknown;
  try {
    const text = await response.text();
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("Daytona runner response was invalid");
  }
  if (!isRecord(value) || typeof value.exitCode !== "number" || typeof value.result !== "string") {
    throw new Error("Daytona runner response was missing exitCode or result");
  }
  return { exitCode: value.exitCode, log: truncateLog(redactEnvStoreOutput(value.result, runtimeEnv)) };
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
  } catch {
    // Lifecycle API responses may contain fragments of previous runner output.
    // Never surface the upstream error text to an MCP caller.
    return { lifecycleStatus: "failed", lifecycleError: "Daytona lifecycle request failed; verify sandbox cleanup" };
  }
}

function filterManagedList(value: unknown, principal?: SandboxPrincipal): unknown {
  if (Array.isArray(value)) return value.filter((item) => isOwnedSandbox(item, principal));
  if (!isRecord(value)) return [];

  for (const key of ["items", "sandboxes", "data"] as const) {
    const items = value[key];
    if (Array.isArray(items)) return { ...value, [key]: items.filter((item) => isOwnedSandbox(item, principal)) };
  }
  return [];
}

export async function runCycle(input: RunCycleInput, principal?: SandboxPrincipal): Promise<CycleResult> {
  const repository = normalizeRepository(input.repository);
  checkPrincipalScope(principal, repository, input.envStore);
  // Reject untrusted repositories and persistent secret executions before any
  // credential fetch or sandbox provisioning. Do not apply to nonsecret runs.
  if (input.envStore) assertTrustedSecretExecution(repository, input.afterRun);
  // Fetch before provisioning: denied scopes never create a sandbox.
  const runtimeEnv = input.envStore ? await loadEnvStoreValues(input.envStore) : {};
  const credentials = await getRepositoryCredentials(repository);
  const normalizedInput: RunCycleInput = { ...input, repository };
  const sandboxId = await createSandbox(normalizedInput, principal);
  let execution: { exitCode: number; log: string };

  try {
    execution = await executeRunner(
      sandboxId,
      "fresh",
      input.timeoutSeconds,
      credentials,
      input.branch,
      "reset",
      input.command,
      input.workingPath,
      runtimeEnv,
    );
  } catch (error) {
    const lifecycle = await applyAfterRun(sandboxId, input.afterRun);
    const suffix = lifecycle.lifecycleError ? ` Lifecycle action also failed: ${lifecycle.lifecycleError}` : "";
    throw new Error(`${errorMessage(error)}${suffix}`);
  }

  const lifecycle = await applyAfterRun(sandboxId, input.afterRun);
  return {
    repository,
    branch: input.branch,
    sandboxId,
    exitCode: execution.exitCode,
    log: execution.log,
    afterRun: input.afterRun,
    ...lifecycle,
  };
}

export async function rerunCycle(input: RerunCycleInput, principal?: SandboxPrincipal): Promise<CycleResult> {
  const sandbox = await getManagedSandboxRaw(input.sandboxId, principal);
  const context = managedContext(sandbox);
  checkPrincipalScope(principal, context.repository, input.envStore);
  // On rerun trust the repository derived from managed sandbox labels,
  // never an arbitrary caller-provided project/repository string.
  if (input.envStore) assertTrustedSecretExecution(context.repository, input.afterRun);
  // Any error after ownership and policy checks must still honor after_run.
  // This includes secret lookup, GitHub auth, sandbox start and runner failures.
  try {
    const runtimeEnv = input.envStore ? await loadEnvStoreValues(input.envStore) : {};
    const credentials = await getRepositoryCredentials(context.repository);
    await ensureStarted(input.sandboxId, sandbox);
    const execution = await executeRunner(
      input.sandboxId,
      "rerun",
      input.timeoutSeconds,
      credentials,
      undefined,
      input.syncMode,
      input.command,
      input.workingPath,
      runtimeEnv,
    );
    const lifecycle = await applyAfterRun(input.sandboxId, input.afterRun);
    return {
      ...context,
      repository: credentials.repository,
      sandboxId: input.sandboxId,
      exitCode: execution.exitCode,
      log: execution.log,
      afterRun: input.afterRun,
      ...lifecycle,
    };
  } catch (error) {
    const lifecycle = await applyAfterRun(input.sandboxId, input.afterRun);
    const suffix = lifecycle.lifecycleError ? ` Lifecycle action also failed: ${lifecycle.lifecycleError}` : "";
    throw new Error(`${errorMessage(error)}${suffix}`);
  }
}

export async function listManagedSandboxes(principal?: SandboxPrincipal): Promise<unknown> {
  return filterManagedList(await requestJson("/sandbox"), principal);
}

export async function getManagedSandbox(sandboxId: string, principal?: SandboxPrincipal): Promise<unknown> {
  return getManagedSandboxRaw(sandboxId, principal);
}

export async function manageSandbox(sandboxId: string, action: SandboxAction, principal?: SandboxPrincipal): Promise<void> {
  await getManagedSandboxRaw(sandboxId, principal);
  await request(`/sandbox/${encodeURIComponent(sandboxId)}/${action}`, { method: "POST" });
}

export async function configureSandbox(sandboxId: string, setting: LifecycleSetting, minutes: number, principal?: SandboxPrincipal): Promise<void> {
  await getManagedSandboxRaw(sandboxId, principal);
  const pathBySetting: Record<LifecycleSetting, string> = {
    auto_stop: "autostop",
    auto_pause: "autopause",
    auto_delete: "autodelete",
  };
  await request(`/sandbox/${encodeURIComponent(sandboxId)}/${pathBySetting[setting]}/${minutes}`, { method: "POST" });
}

export async function destroySandbox(sandboxId: string, principal?: SandboxPrincipal): Promise<void> {
  await getManagedSandboxRaw(sandboxId, principal);
  await request(`/sandbox/${encodeURIComponent(sandboxId)}`, { method: "DELETE" });
}
