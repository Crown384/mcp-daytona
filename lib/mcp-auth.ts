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
