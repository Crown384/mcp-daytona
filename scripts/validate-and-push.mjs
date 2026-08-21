import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const LOG_FILE = "mcp-daytona-validation.log";
const LOCK_FILE = "pnpm-lock.yaml";
const startedAt = new Date();
const started = performance.now();
const pnpmCli = process.env.npm_execpath?.trim();
const results = [];

writeFileSync(
  LOG_FILE,
  ["MCP Daytona validation", `Started: ${startedAt.toISOString()}`, "=".repeat(88), ""].join("\n"),
  "utf8",
);

function log(text = "") {
  const line = `${text}\n`;
  process.stdout.write(line);
  appendFileSync(LOG_FILE, line, "utf8");
}

function stream(text) {
  process.stdout.write(text);
  appendFileSync(LOG_FILE, text, "utf8");
}

function consoleOnly(text = "") {
  process.stdout.write(`${text}\n`);
}

function run(label, command, args, displayCommand = `${command} ${args.join(" ")}`, envOverrides = {}) {
  const stepStarted = performance.now();
  log(`\n${"=".repeat(88)}`);
  log(label.toUpperCase());
  log(displayCommand);
  log("-".repeat(88));

  return new Promise((resolve) => {
    let processError;
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...envOverrides },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", stream);
    child.stderr.on("data", stream);

    child.on("error", (error) => {
      processError = error;
      log(`PROCESS ERROR: ${error.message}`);
    });

    child.on("close", (code) => {
      const exitCode = processError ? 1 : (code ?? 1);
      const durationSeconds = (performance.now() - stepStarted) / 1000;
      results.push({ label, exitCode, durationSeconds });
      log(`RESULT: ${exitCode === 0 ? "PASS" : "FAIL"} (exit ${exitCode})`);
      log(`DURATION: ${durationSeconds.toFixed(1)}s`);
      resolve(exitCode === 0);
    });
  });
}

function runPnpm(label, args, envOverrides = {}) {
  const displayCommand = `pnpm ${args.join(" ")}`;
  if (pnpmCli) {
    return run(label, process.execPath, [pnpmCli, ...args], displayCommand, envOverrides);
  }
  return run(label, "pnpm", args, displayCommand, envOverrides);
}

function record(label, passed, detail) {
  results.push({ label, exitCode: passed ? 0 : 1, durationSeconds: 0 });
  log(`${passed ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  return passed;
}

function gitOutput(args) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function workingTreeChangesWithoutLog() {
  return gitOutput(["status", "--porcelain", "--untracked-files=all"])
    .split("\n")
    .filter(Boolean)
    .filter((line) => !line.endsWith(` ${LOG_FILE}`) && !line.endsWith(` \"${LOG_FILE}\"`));
}

function isOnlyLockfileChange(changes) {
  return changes.every((line) => line.endsWith(` ${LOCK_FILE}`) || line.endsWith(` \"${LOCK_FILE}\"`));
}

function hasPackageScript(name) {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  return typeof packageJson.scripts?.[name] === "string";
}

function runnerTemplateIssues() {
  const source = readFileSync("lib/runner.ts", "utf8");
  const marker = "String.raw`";
  const start = source.indexOf(marker);
  const end = source.lastIndexOf("`;");
  if (start < 0 || end <= start) return ["RUNNER_SCRIPT String.raw template could not be located"];

  const body = source.slice(start + marker.length, end);
  const issues = [];
  if (body.includes("\\${")) issues.push("escaped shell parameter expansion would remain literal at runtime");
  if (body.includes("\\\\n")) issues.push("double-escaped newline found inside raw Bash template");
  if (!body.includes('ACTION="$(printenv ACTION')) issues.push("ACTION is not read from the runner environment");
  if (!body.includes('SYNC_MODE="$(printenv SYNC_MODE')) issues.push("SYNC_MODE is not read from the runner environment");
  return issues;
}

function printProcessOutput(result) {
  if (result.stdout) consoleOnly(result.stdout.trimEnd());
  if (result.stderr) consoleOnly(result.stderr.trimEnd());
  if (result.error) consoleOnly(`PROCESS ERROR: ${result.error.message}`);
}

function commitAndPushArtifacts(branch, validationPassed, includeLockfile) {
  log(`\n${"=".repeat(88)}`);
  log("VALIDATION ARTIFACT COMMIT + PUSH");
  log(includeLockfile
    ? "The validation log and generated pnpm lockfile will be committed and pushed."
    : "The validation log will be committed and pushed.");

  const paths = includeLockfile ? [LOG_FILE, LOCK_FILE] : [LOG_FILE];
  const add = spawnSync("git", ["add", "--", ...paths], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  printProcessOutput(add);
  if (add.status !== 0) return false;

  const commitMessage = includeLockfile
    ? "chore: sync dependencies and record mcp-daytona validation"
    : validationPassed
      ? "chore: record passing mcp-daytona validation"
      : "chore: record failing mcp-daytona validation";
  const commit = spawnSync("git", ["commit", "--only", ...paths, "-m", commitMessage], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  printProcessOutput(commit);
  if (commit.status !== 0) {
    consoleOnly("Could not commit validation artifacts.");
    return false;
  }

  const push = spawnSync("git", ["push", "origin", `HEAD:${branch}`], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  printProcessOutput(push);
  consoleOnly(`PUSH RESULT: ${push.status === 0 ? "PASS" : "FAIL"} (exit ${push.status ?? 1})`);
  return push.status === 0;
}

const branch = gitOutput(["branch", "--show-current"]);
const head = gitOutput(["rev-parse", "HEAD"]);
const initialChanges = workingTreeChangesWithoutLog();

log("PRE-FLIGHT");
record("Git head", Boolean(head), head || "unable to resolve HEAD");
record("Git branch", Boolean(branch), branch || "detached HEAD is not supported");
record("Git working tree", initialChanges.length === 0, initialChanges.length === 0 ? "clean" : initialChanges.join(" | "));

let canValidate = Boolean(head) && Boolean(branch) && initialChanges.length === 0;
let lockfileChanged = false;

if (canValidate) {
  const runnerIssues = runnerTemplateIssues();
  canValidate = record(
    "Runner template sanity check",
    runnerIssues.length === 0,
    runnerIssues.length === 0 ? "shell environment expansion and raw-string escaping look valid" : runnerIssues.join(" | "),
  ) && canValidate;

  canValidate = await runPnpm(
    "Install dependencies",
    ["install", "--no-frozen-lockfile", "--reporter=append-only"],
    { CI: "true" },
  ) && canValidate;
  const installChanges = workingTreeChangesWithoutLog();
  lockfileChanged = installChanges.some((line) => line.endsWith(` ${LOCK_FILE}`) || line.endsWith(` \"${LOCK_FILE}\"`));
  canValidate = record(
    "Dependency metadata diff check",
    isOnlyLockfileChange(installChanges),
    installChanges.length === 0 ? "lockfile already synchronized" : installChanges.join(" | "),
  ) && canValidate;

  canValidate = await runPnpm("Typecheck", ["run", "typecheck"]) && canValidate;
  canValidate = await runPnpm("Lint", ["run", "lint"]) && canValidate;

  if (hasPackageScript("test")) {
    canValidate = await runPnpm("Tests", ["run", "test"]) && canValidate;
  } else {
    results.push({ label: "Tests", exitCode: 0, durationSeconds: 0, skipped: true });
    log("\nSKIP  Tests — no test script configured");
  }

  if (hasPackageScript("fallow")) {
    canValidate = await runPnpm("Fallow audit", ["run", "fallow"]) && canValidate;
  } else if (existsSync("node_modules/.bin/fallow") || existsSync("node_modules/.bin/fallow.cmd")) {
    canValidate = await runPnpm("Fallow audit", ["exec", "fallow"]) && canValidate;
  } else {
    results.push({ label: "Fallow audit", exitCode: 0, durationSeconds: 0, skipped: true });
    log("\nSKIP  Fallow audit — Fallow is not configured in this repository");
  }

  rmSync(".open-next", { recursive: true, force: true });
  canValidate = await runPnpm("Cloudflare production build", ["run", "cf:build"]) && canValidate;

  const postChanges = workingTreeChangesWithoutLog();
  canValidate = record(
    "Post-validation Git diff check",
    isOnlyLockfileChange(postChanges),
    postChanges.length === 0 ? "only the validation log changed" : postChanges.join(" | "),
  ) && canValidate;
}

const completedAt = new Date();
const durationSeconds = (performance.now() - started) / 1000;
const failed = results.filter((result) => !result.skipped && result.exitCode !== 0);
const passed = results.filter((result) => !result.skipped && result.exitCode === 0);
const skipped = results.filter((result) => result.skipped);
const validationPassed = failed.length === 0 && canValidate;

log(`\n${"=".repeat(88)}`);
log("FINAL SUMMARY");
for (const result of results) {
  const prefix = result.skipped ? "SKIP" : result.exitCode === 0 ? "PASS" : "FAIL";
  log(`${prefix.padEnd(5)} ${result.label}`);
}
log(`TOTAL: ${results.length}`);
log(`PASSED: ${passed.length}`);
log(`FAILED: ${failed.length}`);
log(`SKIPPED: ${skipped.length}`);
log(`RESULT: ${validationPassed ? "PASS" : "FAIL"} (exit ${validationPassed ? 0 : 1})`);
log(`DURATION: ${durationSeconds.toFixed(1)}s`);
log(`Completed: ${completedAt.toISOString()}`);
log(`Log file: ${LOG_FILE}`);

if (!branch) {
  log("\nValidation artifacts were not pushed because the repository is on a detached HEAD.");
  process.exit(1);
}

const pushed = commitAndPushArtifacts(branch, validationPassed, lockfileChanged);
process.exit(validationPassed && pushed ? 0 : 1);
