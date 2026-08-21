import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const LOG_FILE = "mcp-daytona-validation.log";
const startedAt = new Date();
const started = performance.now();
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const results = [];

writeFileSync(
  LOG_FILE,
  [
    "MCP Daytona validation",
    `Started: ${startedAt.toISOString()}`,
    "=".repeat(88),
    "",
  ].join("\n"),
  "utf8",
);

function log(text = "") {
  process.stdout.write(`${text}\n`);
  appendFileSync(LOG_FILE, `${text}\n`, "utf8");
}

function run(label, command, args, options = {}) {
  const stepStarted = performance.now();
  log(`\n${"=".repeat(88)}`);
  log(label.toUpperCase());
  log(`${command} ${args.join(" ")}`);
  log("-".repeat(88));

  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
    ...options,
  });

  if (result.stdout) log(result.stdout.trimEnd());
  if (result.stderr) log(result.stderr.trimEnd());

  const exitCode = result.status ?? 1;
  const durationSeconds = (performance.now() - stepStarted) / 1000;
  results.push({ label, exitCode, durationSeconds });
  log(`RESULT: ${exitCode === 0 ? "PASS" : "FAIL"} (exit ${exitCode})`);
  log(`DURATION: ${durationSeconds.toFixed(1)}s`);
  return exitCode === 0;
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

function hasPackageScript(name) {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  return typeof packageJson.scripts?.[name] === "string";
}

function commitAndPushLog(branch, validationPassed) {
  log(`\n${"=".repeat(88)}`);
  log("LOG COMMIT + PUSH");
  log("-".repeat(88));

  const add = spawnSync("git", ["add", "--", LOG_FILE], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  if (add.stdout) log(add.stdout.trimEnd());
  if (add.stderr) log(add.stderr.trimEnd());
  if (add.status !== 0) return false;

  const commitMessage = validationPassed
    ? "chore: record passing mcp-daytona validation"
    : "chore: record failing mcp-daytona validation";
  const commit = spawnSync("git", ["commit", "--only", LOG_FILE, "-m", commitMessage], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  if (commit.stdout) log(commit.stdout.trimEnd());
  if (commit.stderr) log(commit.stderr.trimEnd());

  if (commit.status !== 0) {
    log("Could not commit validation log.");
    return false;
  }

  const push = spawnSync("git", ["push", "origin", `HEAD:${branch}`], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  if (push.stdout) log(push.stdout.trimEnd());
  if (push.stderr) log(push.stderr.trimEnd());
  log(`PUSH RESULT: ${push.status === 0 ? "PASS" : "FAIL"} (exit ${push.status ?? 1})`);
  return push.status === 0;
}

const branch = gitOutput(["branch", "--show-current"]);
const head = gitOutput(["rev-parse", "HEAD"]);
const initialStatus = gitOutput(["status", "--porcelain", "--untracked-files=all"])
  .split("\n")
  .filter(Boolean)
  .filter((line) => !line.endsWith(` ${LOG_FILE}`) && !line.endsWith(` \"${LOG_FILE}\"`));

log("PRE-FLIGHT");
record("Git head", Boolean(head), head || "unable to resolve HEAD");
record("Git branch", Boolean(branch), branch || "detached HEAD is not supported");
record("Git working tree", initialStatus.length === 0, initialStatus.length === 0 ? "clean" : initialStatus.join(" | "));

let canValidate = Boolean(head) && Boolean(branch) && initialStatus.length === 0;

if (canValidate) {
  canValidate = run("Install dependencies", pnpm, ["install", "--frozen-lockfile"]) && canValidate;
  canValidate = run("Typecheck", pnpm, ["run", "typecheck"]) && canValidate;
  canValidate = run("Lint", pnpm, ["run", "lint"]) && canValidate;

  if (hasPackageScript("test")) {
    canValidate = run("Tests", pnpm, ["run", "test"]) && canValidate;
  } else {
    results.push({ label: "Tests", exitCode: 0, durationSeconds: 0, skipped: true });
    log("\nSKIP  Tests — no test script configured");
  }

  if (hasPackageScript("fallow")) {
    canValidate = run("Fallow audit", pnpm, ["run", "fallow"]) && canValidate;
  } else if (existsSync("node_modules/.bin/fallow") || existsSync("node_modules/.bin/fallow.cmd")) {
    canValidate = run("Fallow audit", pnpm, ["exec", "fallow"]) && canValidate;
  } else {
    results.push({ label: "Fallow audit", exitCode: 0, durationSeconds: 0, skipped: true });
    log("\nSKIP  Fallow audit — Fallow is not configured in this repository");
  }

  canValidate = run("Cloudflare production build", pnpm, ["run", "cf:build"]) && canValidate;
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
  log("\nLog was not pushed because the repository is on a detached HEAD.");
  process.exit(1);
}

const pushed = commitAndPushLog(branch, validationPassed);
process.exit(validationPassed && pushed ? 0 : 1);
