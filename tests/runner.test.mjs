import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

const runnerSource = readFileSync(resolve("lib/runner.ts"), "utf8");
const configSource = readFileSync(resolve("lib/config.ts"), "utf8");
const githubAppSource = readFileSync(resolve("lib/github-app.ts"), "utf8");
const daytonaSource = readFileSync(resolve("lib/daytona.ts"), "utf8");
const mcpSource = readFileSync(resolve("lib/mcp.ts"), "utf8");
const smokeSource = readFileSync(resolve("scripts/daytona-smoke.mjs"), "utf8");
const marker = "String.raw`";
const start = runnerSource.indexOf(marker);
const end = runnerSource.lastIndexOf("`;");
assert.ok(start >= 0 && end > start, "RUNNER_SCRIPT raw template must exist");
const runner = runnerSource.slice(start + marker.length, end);
const executeRunnerStart = daytonaSource.indexOf("async function executeRunner");
const ensureStartedStart = daytonaSource.indexOf("async function ensureStarted");
assert.ok(executeRunnerStart >= 0 && ensureStartedStart > executeRunnerStart, "executeRunner function must exist");
const executeRunnerSource = daytonaSource.slice(executeRunnerStart, ensureStartedStart);

test("removed repository allowlist cannot regress", () => {
  for (const source of [configSource, githubAppSource, daytonaSource, runnerSource, mcpSource]) {
    assert.equal(source.includes("ALLOWED_GITHUB_REPOS"), false);
    assert.equal(source.includes("allowedRepositories"), false);
  }
});

test("Daytona region is not hardcoded", () => {
  assert.equal(configSource.includes("DAYTONA_TARGET"), false);
  assert.equal(configSource.includes("daytonaTarget"), false);
  assert.equal(/\btarget\s*:/.test(daytonaSource), false);
});

test("GitHub App is the only server-side repository auth path", () => {
  assert.match(configSource, /GITHUB_APP_ID/);
  assert.match(configSource, /GITHUB_APP_PRIVATE_KEY_BASE64/);
  assert.match(githubAppSource, /getRepositoryCredentials/);
  assert.match(githubAppSource, /return appCredentials\(repository\)/);
  assert.match(githubAppSource, /x-access-token/);
  assert.equal(configSource.includes("GITHUB_OWNER"), false);
  assert.equal(configSource.includes("GITHUB_TOKEN"), false);
  assert.equal(githubAppSource.includes("legacyCredentials"), false);
  assert.equal(githubAppSource.includes("githubOwner"), false);
  assert.equal(githubAppSource.includes("githubToken"), false);
});

test("GitHub App signs RS256 JWTs and resolves repository installations", () => {
  assert.match(githubAppSource, /RSASSA-PKCS1-v1_5/);
  assert.match(githubAppSource, /SHA-256/);
  assert.match(githubAppSource, /\/repos\/\$\{encodeURIComponent\(owner\)\}\/\$\{encodeURIComponent\(name\)\}\/installation/);
  assert.match(githubAppSource, /\/app\/installations\/\$\{installationId\}\/access_tokens/);
  assert.match(githubAppSource, /TOKEN_CACHE_SKEW_MS/);
});

test("GitHub App private key supports GitHub RSA PEM and PKCS8 PEM", () => {
  assert.match(githubAppSource, /BEGIN RSA PRIVATE KEY/);
  assert.match(githubAppSource, /BEGIN PRIVATE KEY/);
  assert.match(githubAppSource, /pkcs1ToPkcs8/);
  assert.match(githubAppSource, /crypto\.subtle\.importKey/);
});

test("repository normalization requires full owner/repo and has no owner fallback", () => {
  assert.match(githubAppSource, /repository must be in owner\/repo form/);
  assert.match(githubAppSource, /REPOSITORY_PATTERN\.test\(trimmed\)/);
  assert.equal(githubAppSource.includes("config.githubOwner"), false);
  assert.match(mcpSource, /Bare repository names are invalid/);
  assert.match(mcpSource, /Onestepsmarter\/afri_cart/);
  assert.match(mcpSource, /const REPOSITORY_PATTERN = \/\^\[A-Za-z0-9_\.\-\]\+\\\/\[A-Za-z0-9_\.\-\]\+\$\//);
});

test("production Daytona API retries transient safe requests ten times", () => {
  assert.match(daytonaSource, /const API_RETRY_ATTEMPTS = 10/);
  assert.match(daytonaSource, /function isRetryableStatus/);
  assert.match(daytonaSource, /status === 429 \|\| status >= 500/);
  assert.match(daytonaSource, /retry-after-sandbox-create/);
  assert.match(daytonaSource, /\["GET", "HEAD", "PUT", "DELETE"\]/);
  assert.match(daytonaSource, /async function fetchWithRetry/);
});

test("sandbox creation uses one recoverable name across retries", () => {
  assert.match(daytonaSource, /function newSandboxName/);
  assert.match(daytonaSource, /crypto\.randomUUID\(\)/);
  assert.match(daytonaSource, /async function tryRecoverSandbox/);
  assert.match(daytonaSource, /async function createSandboxRequest/);
  assert.match(daytonaSource, /name,\s*\n\s*snapshot:/);
  assert.match(daytonaSource, /createSandboxRequest\(input, newSandboxName\(\)\)/);
});

test("Daytona resolves GitHub credentials before creating a fresh sandbox", () => {
  const runCycleStart = daytonaSource.indexOf("export async function runCycle");
  const rerunStart = daytonaSource.indexOf("export async function rerunCycle");
  const runCycleSource = daytonaSource.slice(runCycleStart, rerunStart);
  assert.ok(runCycleStart >= 0 && rerunStart > runCycleStart);
  assert.ok(runCycleSource.indexOf("getRepositoryCredentials(repository)") < runCycleSource.indexOf("createSandbox(normalizedInput)"));
});

test("arbitrary command execution is single-shot and never automatically retried", () => {
  assert.equal(executeRunnerSource.includes("fetchWithRetry"), false);
  assert.match(executeRunnerSource, /await fetch\(/);
  assert.match(executeRunnerSource, /was not retried because the command may already have started/);
});

test("runner raw template does not leak escaped shell parameter expansions", () => {
  assert.equal(runner.includes("\\${"), false);
  assert.equal(runner.includes("\\\\n"), false);
});

test("runner reads required environment values explicitly", () => {
  for (const name of [
    "ACTION",
    "SYNC_MODE",
    "GITHUB_USERNAME",
    "GITHUB_TOKEN",
    "GIT_IDENTITY_NAME",
    "GIT_IDENTITY_EMAIL",
    "REPOSITORY",
    "BRANCH",
    "COMMAND",
    "WORKING_PATH",
  ]) {
    assert.match(runner, new RegExp(`printenv ${name}`));
  }
});

test("runner is owner agnostic and clones full owner/repo remotes", () => {
  assert.equal(runner.includes("GITHUB_OWNER"), false);
  assert.match(runner, /REMOTE="https:\/\/github\.com\/\$REPOSITORY\.git"/);
  assert.match(runner, /Repository must be in owner\/repo form/);
  assert.match(runner, /Daytona cycle: %s @ %s/);
});

test("runner preserves compatibility with old persistent checkout context", () => {
  assert.match(runner, /CONTEXT_THREE/);
  assert.match(runner, /REPOSITORY="\$CONTEXT_ONE\/\$CONTEXT_TWO"/);
  assert.match(runner, /printf '%s\\n%s\\n' "\$REPOSITORY" "\$BRANCH"/);
});

test("runner exposes arbitrary command execution with root path default", () => {
  assert.match(runner, /WORKING_PATH=.*printenv WORKING_PATH/);
  assert.match(runner, /WORKING_PATH="\."/);
  assert.match(runner, /with_git_auth bash -lc "\$COMMAND"/);
  assert.match(runner, /== custom command ==/);
});

test("arbitrary commands inherit protected Git authentication", () => {
  assert.match(runner, /unset GITHUB_TOKEN/);
  assert.match(runner, /GIT_ASKPASS="\$ASKPASS" "\$@"/);
  assert.match(runner, /with_git_auth bash -lc "\$COMMAND"/);
});

test("runner configures a local Git identity for nested commit scripts", () => {
  assert.match(runner, /ensure_git_identity\(\)/);
  assert.match(runner, /git config user\.name/);
  assert.match(runner, /git config user\.email/);
  assert.match(runner, /GIT_IDENTITY_NAME/);
  assert.match(runner, /GIT_IDENTITY_EMAIL/);
  assert.match(runner, /ensure_git_identity \|\| exit/);
});

test("runner validates the selected working directory stays in the repo", () => {
  assert.match(runner, /realpath -e/);
  assert.match(runner, /Working path escapes repository/);
  assert.match(runner, /Working path does not exist/);
  assert.match(runner, /Working path is not a directory/);
});

test("MCP schemas expose owner/repo, command, and path on fresh and rerun cycles", () => {
  assert.match(mcpSource, /owner\/repo form/);
  assert.match(mcpSource, /Bare repository names are invalid/);
  assert.match(mcpSource, /const COMMAND_PROPERTIES/);
  assert.match(mcpSource, /command:/);
  assert.match(mcpSource, /path:/);
  assert.match(mcpSource, /default: "\."/);
  assert.match(mcpSource, /command: parseCommand\(args\)/);
  assert.match(mcpSource, /workingPath: parseWorkingPath\(args\)/);
});

test("MCP rejects absolute and parent-traversal paths", () => {
  assert.match(mcpSource, /path must be relative to the repository root/);
  assert.match(mcpSource, /path cannot traverse outside the repository/);
});

test("runner keeps GitHub token secret while Git commands authenticate", () => {
  assert.match(runner, /TOKEN_SECRET=.*GITHUB_TOKEN/);
  assert.match(runner, /unset GITHUB_TOKEN/);
  assert.match(runner, /GIT_TERMINAL_PROMPT=0/);
  assert.match(runner, /with_git_auth bash -lc "\$COMMAND"/);
});

test("runner Git credentials are temporary, cleaned, and use supplied username", () => {
  assert.match(runner, /with_git_auth\(\) \(/);
  assert.match(runner, /trap 'rm -f/);
  assert.match(runner, /GIT_ASKPASS=/);
  assert.match(runner, /\*Username\*\).*GITHUB_USERNAME/);
  assert.match(runner, /GITHUB_USERNAME="x-access-token"/);
});

test("runner implementation never pushes source on its own", () => {
  assert.equal(/git\s+push/.test(runner), false);
  assert.equal(/git\s+commit/.test(runner), false);
  assert.equal(/git\s+add/.test(runner), false);
});

test("custom terminal commands may leave working-tree changes without forced failure", () => {
  assert.match(runner, /git status --porcelain/);
  assert.match(runner, /if \[ -z "\$COMMAND" \]; then/);
  assert.match(runner, /Repository working tree contains changes from the custom command/);
  assert.match(runner, /Repository working tree changed during the automatic QA cycle/);
});

test("live smoke validates GitHub App access across Crown384 and Onestepsmarter", () => {
  assert.match(smokeSource, /const REPOSITORY = "Crown384\/pamaos-next"/);
  assert.match(smokeSource, /const SECONDARY_REPOSITORY = "Onestepsmarter\/afri_cart"/);
  assert.match(smokeSource, /GITHUB_APP_ID/);
  assert.match(smokeSource, /GITHUB_APP_PRIVATE_KEY_BASE64/);
  assert.match(smokeSource, /assertRepositoryAccess\(REPOSITORY\)/);
  assert.match(smokeSource, /assertRepositoryAccess\(SECONDARY_REPOSITORY\)/);
});

test("live smoke test uses exact runner, authenticated git pull, command, and cleanup", () => {
  assert.match(smokeSource, /loadRunnerScript/);
  assert.match(smokeSource, /const BRANCH = "main"/);
  assert.match(smokeSource, /git pull --ff-only origin/);
  assert.match(smokeSource, /SMOKE_PULL=ok/);
  assert.match(smokeSource, /GITHUB_USERNAME: "x-access-token"/);
  assert.match(smokeSource, /COMMAND: smokeCommand/);
  assert.match(smokeSource, /WORKING_PATH: "\."/);
  assert.match(smokeSource, /== custom command ==/);
  assert.match(smokeSource, /finally \{/);
  assert.match(smokeSource, /method: "DELETE"/);
  assert.match(smokeSource, /SANDBOX_DESTROYED=/);
});

test("live smoke normalizes Windows line endings before Linux execution", () => {
  assert.match(smokeSource, /replace\(\/\\r\\n\?\/g, "\\n"\)/);
});

test("live smoke retries transient network failures ten times", () => {
  assert.match(smokeSource, /const FETCH_ATTEMPTS = 10/);
});

test("runner Bash syntax is valid when bash is installed", (context) => {
  const probe = spawnSync("bash", ["--version"], { encoding: "utf8", windowsHide: true });
  if (probe.error || probe.status !== 0) {
    context.skip("bash is not available on PATH");
    return;
  }

  const syntax = spawnSync("bash", ["-n"], {
    input: runner,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(syntax.status, 0, syntax.stderr || "runner Bash syntax check failed");
});
