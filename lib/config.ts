const OWNER_PATTERN = /^[A-Za-z0-9_.-]+$/;
const APP_ID_PATTERN = /^\d+$/;

export type AppConfig = Readonly<{
  daytonaApiKey: string;
  daytonaApiUrl: string;
  githubAppId?: string;
  githubAppPrivateKeyBase64?: string;
  githubToken?: string;
  githubOwner?: string;
}>;

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function requireEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function getConfig(): AppConfig {
  const githubAppId = optionalEnv("GITHUB_APP_ID");
  const githubAppPrivateKeyBase64 = optionalEnv("GITHUB_APP_PRIVATE_KEY_BASE64");
  const githubToken = optionalEnv("GITHUB_TOKEN");
  const githubOwner = optionalEnv("GITHUB_OWNER");
  const hasAppCredentials = Boolean(githubAppId && githubAppPrivateKeyBase64);

  if ((githubAppId || githubAppPrivateKeyBase64) && !hasAppCredentials) {
    throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_BASE64 must be configured together");
  }
  if (githubAppId && !APP_ID_PATTERN.test(githubAppId)) {
    throw new Error("GITHUB_APP_ID must be numeric");
  }

  if (!hasAppCredentials) {
    if (!(githubToken && githubOwner)) {
      throw new Error(
        "Configure GitHub App credentials (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY_BASE64) or legacy PAT credentials (GITHUB_TOKEN + GITHUB_OWNER)",
      );
    }
  }

  if (githubOwner && !OWNER_PATTERN.test(githubOwner)) {
    throw new Error("GITHUB_OWNER contains invalid characters");
  }

  return {
    daytonaApiKey: requireEnv("DAYTONA_API_KEY"),
    daytonaApiUrl: (process.env.DAYTONA_API_URL?.trim() || "https://app.daytona.io/api").replace(/\/$/, ""),
    githubAppId,
    githubAppPrivateKeyBase64,
    githubToken: githubToken && githubOwner ? githubToken : undefined,
    githubOwner: githubToken && githubOwner ? githubOwner : undefined,
  };
}
