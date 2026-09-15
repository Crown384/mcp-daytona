import { getConfig } from "./config";

const GITHUB_API = "https://api.github.com";
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TOKEN_CACHE_SKEW_MS = 5 * 60 * 1000;

type JsonRecord = Record<string, unknown>;
type CachedToken = Readonly<{ token: string; expiresAt: number }>;

const installationTokenCache = new Map<string, CachedToken>();
let importedPrivateKey: Promise<CryptoKey> | undefined;

export type RepositoryCredentials = Readonly<{
  repository: string;
  owner: string;
  token: string;
  username: string;
  identityName: string;
  identityEmail: string;
}>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function derLength(length: number): Uint8Array {
  if (length < 128) return Uint8Array.of(length);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function derWrap(tag: number, value: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(tag), derLength(value.length), value);
}

function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithmIdentifier = Uint8Array.of(
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00,
  );
  return derWrap(0x30, concatBytes(version, rsaAlgorithmIdentifier, derWrap(0x04, pkcs1)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function privateKeyDer(base64WrappedPem: string): Uint8Array {
  const pem = new TextDecoder().decode(bytesFromBase64(base64WrappedPem));
  const pkcs8Match = pem.match(/-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/);
  if (pkcs8Match) return bytesFromBase64(pkcs8Match[1]);

  const pkcs1Match = pem.match(/-----BEGIN RSA PRIVATE KEY-----([\s\S]+?)-----END RSA PRIVATE KEY-----/);
  if (pkcs1Match) return pkcs1ToPkcs8(bytesFromBase64(pkcs1Match[1]));

  throw new Error(
    "GITHUB_APP_PRIVATE_KEY_BASE64 did not decode to a supported GitHub App PEM private key",
  );
}

async function appPrivateKey(): Promise<CryptoKey> {
  if (importedPrivateKey) return importedPrivateKey;
  const config = getConfig();
  if (!config.githubAppPrivateKeyBase64) throw new Error("GitHub App private key is not configured");
  importedPrivateKey = crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(privateKeyDer(config.githubAppPrivateKeyBase64)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return importedPrivateKey;
}

async function appJwt(): Promise<string> {
  const config = getConfig();
  if (!config.githubAppId) throw new Error("GitHub App ID is not configured");

  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({ iat: now - 60, exp: now + 9 * 60, iss: config.githubAppId });
  const unsigned = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    await appPrivateKey(),
    toArrayBuffer(new TextEncoder().encode(unsigned)),
  );
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

async function githubJson(path: string, token: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  headers.set("User-Agent", "mcp-daytona");

  const response = await fetch(`${GITHUB_API}${path}`, { ...init, headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub App request ${path} failed (${response.status}): ${text.slice(0, 1000)}`);
  }
  return text ? JSON.parse(text) : {};
}

export function normalizeRepository(repository: string): string {
  const trimmed = repository.trim();
  if (!REPOSITORY_PATTERN.test(trimmed)) {
    throw new Error("repository must be in owner/repo form");
  }
  return trimmed;
}

function splitRepository(repository: string): { owner: string; name: string } {
  const normalized = normalizeRepository(repository);
  const separator = normalized.indexOf("/");
  return { owner: normalized.slice(0, separator), name: normalized.slice(separator + 1) };
}

async function installationIdForRepository(repository: string, jwt: string): Promise<number> {
  const { owner, name } = splitRepository(repository);
  const value = await githubJson(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
    jwt,
  );
  if (!isRecord(value) || typeof value.id !== "number") {
    throw new Error(`GitHub App installation lookup for ${repository} did not return an installation id`);
  }
  return value.id;
}

async function installationToken(
  installationId: number,
  repository: string,
  repositoryName: string,
  jwt: string,
): Promise<string> {
  const cached = installationTokenCache.get(repository);
  if (cached && cached.expiresAt - TOKEN_CACHE_SKEW_MS > Date.now()) return cached.token;

  const value = await githubJson(`/app/installations/${installationId}/access_tokens`, jwt, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repositories: [repositoryName] }),
  });
  if (!isRecord(value) || typeof value.token !== "string" || typeof value.expires_at !== "string") {
    throw new Error(`GitHub App installation ${installationId} did not return a usable access token`);
  }

  const expiresAt = Date.parse(value.expires_at);
  if (!Number.isFinite(expiresAt)) throw new Error("GitHub App installation token expiry is invalid");
  installationTokenCache.set(repository, { token: value.token, expiresAt });
  return value.token;
}

async function appCredentials(repository: string): Promise<RepositoryCredentials> {
  const normalized = normalizeRepository(repository);
  const { owner, name } = splitRepository(normalized);
  const jwt = await appJwt();
  const installationId = await installationIdForRepository(normalized, jwt);
  const token = await installationToken(installationId, normalized, name, jwt);
  return {
    repository: normalized,
    owner,
    token,
    username: "x-access-token",
    identityName: "Daytona MCP",
    identityEmail: "daytona-mcp@users.noreply.github.com",
  };
}

export async function getRepositoryCredentials(repository: string): Promise<RepositoryCredentials> {
  return appCredentials(repository);
}
