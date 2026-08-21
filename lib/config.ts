const OWNER_PATTERN = /^[A-Za-z0-9_.-]+$/;

export type AppConfig = Readonly<{
  daytonaApiKey: string;
  daytonaApiUrl: string;
  daytonaTarget: string;
  githubToken: string;
  githubOwner: string;
  allowedRepositories: ReadonlySet<string>;
}>;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseRepositories(value: string): ReadonlySet<string> {
  const repositories = value
    .split(",")
    .map((repository) => repository.trim())
    .filter(Boolean);

  if (repositories.length === 0) {
    throw new Error("ALLOWED_GITHUB_REPOS must contain at least one repository");
  }

  return new Set(repositories);
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
    allowedRepositories: parseRepositories(requireEnv("ALLOWED_GITHUB_REPOS")),
  };
}

export function assertAllowedRepository(config: AppConfig, repository: string): void {
  if (!config.allowedRepositories.has(repository)) {
    throw new Error(`Repository is not allowed: ${repository}`);
  }
}
