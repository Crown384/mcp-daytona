import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

const runnerSource = readFileSync(resolve("lib/runner.ts"), "utf8");
const marker = "String.raw`";
const start = runnerSource.indexOf(marker);
const end = runnerSource.lastIndexOf("`;");
assert.ok(start >= 0 && end > start, "RUNNER_SCRIPT raw template must exist");
const runner = runnerSource.slice(start + marker.length, end);

test("runner raw template does not leak escaped shell parameter expansions", () => {
  assert.equal(runner.includes("\\${"), false);
  assert.equal(runner.includes("\\\\n"), false);
});

test("runner reads required environment values explicitly", () => {
  for (const name of ["ACTION", "SYNC_MODE", "GITHUB_OWNER", "GITHUB_TOKEN", "REPOSITORY", "BRANCH"]) {
    assert.match(runner, new RegExp(`printenv ${name}`));
  }
});

test("runner keeps GitHub token out of repository child processes", () => {
  assert.match(runner, /TOKEN_SECRET=.*GITHUB_TOKEN/);
  assert.match(runner, /unset GITHUB_TOKEN/);
  assert.match(runner, /GIT_TERMINAL_PROMPT=0/);
});

test("runner Git credentials are temporary and cleaned", () => {
  assert.match(runner, /with_git_auth\(\) \(/);
  assert.match(runner, /trap 'rm -f/);
  assert.match(runner, /GIT_ASKPASS=/);
});

test("runner is read-only and never pushes implementation source", () => {
  assert.equal(/git\s+push/.test(runner), false);
  assert.equal(/git\s+commit/.test(runner), false);
  assert.equal(/git\s+add/.test(runner), false);
});

test("runner rejects dirty working trees caused by QA commands", () => {
  assert.match(runner, /git status --porcelain/);
  assert.match(runner, /Repository working tree changed during the QA cycle/);
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
