const OWNER_PATTERN = /^[A-Za-z0-9_.-]+$/;

export type AppConfig = Readonly<{
  daytonaApiKey: string;
  daytonaApiUrl: string;
  daytonaTarget: string;
  githubToken: string;
  githubOwner: string;
}>;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function getConfig(): AppConfig {
  const githubOwner = requireEnv("GITHUB_OWNER");

  if (!OWNER_PATTERN.test(githubOwner)) {
    throw new Error("GITHUB_OWNER contains invalid characters");
  }

  return {
    daytonaApiKey: requireEnv("DAYTONA_API_KEY"),
    daytonaApiUrl: (process.env.DAYTONA_API_URL?.trim() || "https://app.daytona.io/api").replace(/\/$/, ""),
    daytonaTarget: process.env.DAYTONA_TARGET?.trim() || "us",
    githubToken: requireEnv("GITHUB_TOKEN"),
    githubOwner,
  };
}
