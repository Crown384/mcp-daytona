/**
 * Loads secrets on the trusted Daytona MCP server.
 * The bearer credential is never exposed in tool schemas, shell commands, or returned results.
 * Values exist in the Daytona process environment only for the requested execution.
 */
export type EnvStoreSelection = Readonly<{ project: string; environment: "staging" | "production" }>;

/** Restrict secret-bearing runs; ordinary Daytona/GitHub operations stay unrestricted. */
export function assertTrustedSecretExecution(repository: string, afterRun: string): void {
  if (afterRun !== "delete") {
    throw new Error("Env Store execution requires after_run=delete to prevent persistent secret-bearing sandboxes");
  }
  const policy = process.env.PAMA_ENV_STORE_TRUSTED_REPOS?.trim();
  if (!policy) throw new Error("Env Store trusted repositories are not configured");
  const entries = policy.split(",").map((entry) => entry.trim().toLowerCase());
  const namePattern = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
  if (entries.length > 64 || entries.some((entry) => !namePattern.test(entry))) {
    throw new Error("Env Store trusted repository policy is invalid");
  }
  if (!entries.includes(repository.toLowerCase())) {
    throw new Error("Repository is not trusted for Env Store secret execution");
  }
}

const PROJECT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VARIABLES = 128;
const MAX_BYTES = 128 * 1024;
const MAX_VALUE_LENGTH = 16_384;
const RESERVED = new Set([
  "GITHUB_TOKEN", "GITHUB_USERNAME", "GIT_IDENTITY_NAME", "GIT_IDENTITY_EMAIL",
  "REPOSITORY", "BRANCH", "ACTION", "SYNC_MODE", "COMMAND", "WORKING_PATH",
  "PATH", "HOME", "PWD", "SHELL", "ENV", "BASH_ENV", "BASHOPTS", "SHELLOPTS",
  "IFS", "CDPATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "NODE_OPTIONS",
  "PYTHONPATH", "GIT_ASKPASS", "GIT_TERMINAL_PROMPT",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeEndpoint(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("PAMA_ENV_STORE_URL is invalid"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password ||
      url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("PAMA_ENV_STORE_URL must be an HTTPS origin");
  }
  if (url.hostname === "localhost" || url.hostname.endsWith(".local") ||
      /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.includes(":")) {
    throw new Error("PAMA_ENV_STORE_URL must be a public HTTPS host");
  }
  return url.origin;
}

function allowedName(name: string): boolean {
  return name.length <= 128 && VARIABLE_PATTERN.test(name) &&
    !RESERVED.has(name) && !name.startsWith("GIT_") &&
    !name.startsWith("BASH_FUNC_") && !name.startsWith("MCP_DAYTONA_");
}

function validateValues(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error("Env Store returned invalid environment data");
  const pairs = Object.entries(value);
  if (pairs.length > MAX_VARIABLES) throw new Error("Env Store returned too many variables");
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  let bytes = 0;
  for (const [key, secret] of pairs) {
    if (!allowedName(key) || typeof secret !== "string" || secret.length > MAX_VALUE_LENGTH ||
        secret.includes("\0")) throw new Error("Env Store returned an unsafe environment variable");
    bytes += new TextEncoder().encode(key).length + new TextEncoder().encode(secret).length;
    if (bytes > MAX_BYTES) throw new Error("Env Store environment exceeds the size limit");
    values[key] = secret;
  }
  return values;
}

export async function loadEnvStoreValues(selection: EnvStoreSelection): Promise<Record<string, string>> {
  if (!PROJECT_PATTERN.test(selection.project) || selection.project.length > 96) {
    throw new Error("env_store_project must be a project slug");
  }
  if (selection.environment !== "staging" && selection.environment !== "production") {
    throw new Error("env_store_environment is invalid");
  }
  if (selection.environment === "production" && process.env.PAMA_ENV_STORE_ALLOW_PRODUCTION !== "true") {
    throw new Error("Production Env Store access is disabled on this MCP server");
  }
  const origin = process.env.PAMA_ENV_STORE_URL?.trim();
  const bearer = process.env.PAMA_ENV_STORE_TOKEN?.trim();
  if (!origin || !bearer || !/^pes_[A-Za-z0-9_-]+$/.test(bearer)) {
    throw new Error("Env Store machine access is not configured");
  }
  const endpoint = safeEndpoint(origin) + "/api/projects/" +
    encodeURIComponent(selection.project) + "/env/" + selection.environment;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: { Authorization: "Bearer " + bearer, Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Never embed an upstream error (which may contain credentials) in an MCP result.
    throw new Error("Env Store request failed");
  }
  if (!response.ok) throw new Error("Env Store refused environment access");
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error("Env Store returned invalid JSON"); }
  if (!isRecord(payload) || !isRecord(payload.project) ||
      payload.project.slug !== selection.project || payload.environment !== selection.environment) {
    throw new Error("Env Store returned a mismatched project or environment");
  }
  return validateValues(payload.values);
}

export function redactEnvStoreOutput(text: string, values: Record<string, string>): string {
  let clean = text;
  // Sort by length so that short secrets cannot partially mask long secrets.
  const secrets = [...new Set(Object.values(values).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    clean = clean.replaceAll(secret, "[REDACTED]");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) clean = clean.replaceAll(encoded, "[REDACTED]");
  }
  return clean;
}
