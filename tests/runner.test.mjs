import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

const runnerSource = readFileSync(resolve("lib/runner.ts"), "utf8");
const configSource = readFileSync(resolve("lib/config.ts"), "utf8");
const daytonaSource = readFileSync(resolve("lib/daytona.ts"), "utf8");
const mcpSource = readFileSync(resolve("lib/mcp.ts"), "utf8");
const smokeSource = readFileSync(resolve("scripts/daytona-smoke.mjs"), "utf8");
const marker = "String.raw`";
const start = runnerSource.indexOf(marker);
const end = runnerSource.lastIndexOf("`;");
assert.ok(start >= 0 && end > start, "RUNNER_SCRIPT raw template must exist");
const runner = runnerSource.slice(start + marker.length, end);

test("removed repository allowlist cannot regress", () => {
  for (const source of [configSource, daytonaSource, runnerSource, mcpSource]) {
    assert.equal(source.includes("ALLOWED_GITHUB_REPOS"), false);
    assert.equal(source.includes("allowedRepositories"), false);
  }
});

test("Daytona region is not hardcoded", () => {
  assert.equal(configSource.includes("DAYTONA_TARGET"), false);
  assert.equal(configSource.includes("daytonaTarget"), false);
  assert.equal(/\btarget\s*:/.test(daytonaSource), false);
});

test("runner raw template does not leak escaped shell parameter expansions", () => {
  assert.equal(runner.includes("\\${"), false);
  assert.equal(runner.includes("\\\\n"), false);
});

test("runner reads required environment values explicitly", () => {
  for (const name of [
    "ACTION",
    "SYNC_MODE",
    "GITHUB_OWNER",
    "GITHUB_TOKEN",
    "REPOSITORY",
    "BRANCH",
    "COMMAND",
    "WORKING_PATH",
  ]) {
    assert.match(runner, new RegExp(`printenv ${name}`));
  }
});

test("runner exposes arbitrary command execution with root path default", () => {
  assert.match(runner, /WORKING_PATH=.*printenv WORKING_PATH/);
  assert.match(runner, /WORKING_PATH="\."/);
  assert.match(runner, /bash -lc "\$COMMAND"/);
  assert.match(runner, /== custom command ==/);
});

test("runner validates the selected working directory stays in the repo", () => {
  assert.match(runner, /realpath -e/);
  assert.match(runner, /Working path escapes repository/);
  assert.match(runner, /Working path does not exist/);
  assert.match(runner, /Working path is not a directory/);
});

test("MCP schemas expose command and path on fresh and rerun cycles", () => {
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

test("runner keeps GitHub token out of repository child processes", () => {
  assert.match(runner, /TOKEN_SECRET=.*GITHUB_TOKEN/);
  assert.match(runner, /unset GITHUB_TOKEN/);
  assert.match(runner, /GIT_TERMINAL_PROMPT=0/);
});

test("runner Git credentials are temporary, cleaned, and use configured owner", () => {
  assert.match(runner, /with_git_auth\(\) \(/);
  assert.match(runner, /trap 'rm -f/);
  assert.match(runner, /GIT_ASKPASS=/);
  assert.match(runner, /\*Username\*\).*GITHUB_OWNER/);
  assert.equal(runner.includes("x-access-token"), false);
});

test("runner is read-only and never pushes implementation source", () => {
  assert.equal(/git\s+push/.test(runner), false);
  assert.equal(/git\s+commit/.test(runner), false);
  assert.equal(/git\s+add/.test(runner), false);
});

test("runner rejects dirty working trees caused by execution commands", () => {
  assert.match(runner, /git status --porcelain/);
  assert.match(runner, /Repository working tree changed during the execution cycle/);
});

test("live smoke test uses exact runner, clones pamaos-next main, runs command, and destroys sandbox", () => {
  assert.match(smokeSource, /loadRunnerScript/);
  assert.match(smokeSource, /const REPOSITORY = "pamaos-next"/);
  assert.match(smokeSource, /const BRANCH = "main"/);
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
