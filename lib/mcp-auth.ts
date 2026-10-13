/**
 * Secret-enabled MCP actions require a distinct authenticated caller.
 * This credential is configured on the Worker and never forwarded to Daytona.
 */
export async function authorizeEnvStoreCaller(header: string | null): Promise<boolean> {
  const expected = process.env.PAMA_ENV_STORE_MCP_AUTH_TOKEN;
  if (!expected || expected.length < 32 || !header) return false;
  const match = /^Bearer ([A-Za-z0-9_.-]{32,})$/.exec(header);
  if (!match) return false;

  // Compare fixed-size hashes rather than raw values or lengths.
  const encoder = new TextEncoder();
  const [expectedHash, actualHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(match[1])),
  ]);
  const a = new Uint8Array(expectedHash);
  const b = new Uint8Array(actualHash);
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}


/** Optional multi-principal mode. Hashes only: never store client bearer values. */
export type ClientPrincipal = Readonly<{
  id: string;
  repositories: readonly string[];
  projects: readonly string[];
  environments: readonly ("staging" | "production")[];
}>;

type ClientRecord = ClientPrincipal & Readonly<{ tokenSha256: string; enabled: boolean }>;
type ClientAuth = { authorized: true; principal?: ClientPrincipal } | { authorized: false };

const REPOSITORY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const PROJECT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRINCIPAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOKEN_SHA = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allowedStrings(value: unknown, pattern: RegExp, limit: number): string[] | null {
  if (!Array.isArray(value) || value.length > limit || !value.every(
    (item: unknown) => typeof item === "string" && item.length <= 128 && pattern.test(item),
  )) return null;
  if (new Set(value).size !== value.length) return null;
  return value;
}

/**
 * A deliberately small, static principal registry in a Worker secret.
 * When configured, malformed/empty records MUST NOT fall back to legacy auth.
 * Revocation/rotation is an atomic Worker secret configuration replacement.
 */
function configuredClients(): ClientRecord[] | null {
  const raw = process.env.PAMA_ENV_STORE_MCP_CLIENTS_JSON;
  if (raw === undefined) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) return [];
  const records: ClientRecord[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" ||
        item.id.length > 64 || !PRINCIPAL_ID.test(item.id) ||
        typeof item.tokenSha256 !== "string" || !TOKEN_SHA.test(item.tokenSha256) ||
        typeof item.enabled !== "boolean") return [];
    const repositories = allowedStrings(item.repositories, REPOSITORY, 64);
    const projects = allowedStrings(item.projects, PROJECT, 64);
    const environments = allowedStrings(item.environments, /^(staging|production)$/, 2);
    if (!repositories?.length || !projects || !environments) return [];
    records.push({
      id: item.id, tokenSha256: item.tokenSha256, enabled: item.enabled,
      repositories, projects,
      environments: environments as Array<"staging" | "production">,
    });
  }
  if (new Set(records.map((item) => item.id)).size !== records.length ||
      new Set(records.map((item) => item.tokenSha256)).size !== records.length) return [];
  return records;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameHash(a: string, b: string): boolean {
  let different = 0;
  for (let i = 0; i < 64; i += 1) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
}

export async function authenticateMcpCaller(header: string | null, required: boolean): Promise<ClientAuth> {
  const raw = process.env.PAMA_ENV_STORE_MCP_CLIENTS_JSON;
  if (raw !== undefined) {
    const match = /^Bearer ([A-Za-z0-9_.-]{32,})$/.exec(header ?? "");
    if (!match) return { authorized: false };
    const clients = configuredClients();
    if (!clients?.length) return { authorized: false };
    const digest = await sha256Hex(match[1]);
    let matched: ClientRecord | undefined;
    for (const entry of clients) {
      if (sameHash(digest, entry.tokenSha256)) matched = entry;
    }
    if (!matched?.enabled) return { authorized: false };
    return {
      authorized: true,
      principal: {
        id: matched.id,
        repositories: matched.repositories,
        projects: matched.projects,
        environments: matched.environments,
      },
    };
  }
  if (!required) return { authorized: true };
  return await authorizeEnvStoreCaller(header) ? { authorized: true } : { authorized: false };
}

