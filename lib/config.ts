const APP_ID_PATTERN = /^\d+$/;

export type AppConfig = Readonly<{
  daytonaApiKey: string;
  daytonaApiUrl: string;
  githubAppId: string;
  githubAppPrivateKeyBase64: string;
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
  const githubAppId = requireEnv("GITHUB_APP_ID");
  if (!APP_ID_PATTERN.test(githubAppId)) {
    throw new Error("GITHUB_APP_ID must be numeric");
  }

  return {
    daytonaApiKey: requireEnv("DAYTONA_API_KEY"),
    daytonaApiUrl: (process.env.DAYTONA_API_URL?.trim() || "https://app.daytona.io/api").replace(/\/$/, ""),
    githubAppId,
    githubAppPrivateKeyBase64: requireEnv("GITHUB_APP_PRIVATE_KEY_BASE64"),
  };
}
