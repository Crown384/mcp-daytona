import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
  process.stdout.write(`${text}\n`);
  appendFileSync(LOG_FILE, `${text}\n`, "utf8");
}

function consoleOnly(text = "") {
  process.stdout.write(`${text}\n`);
}

function run(label, command, args, displayCommand = `${command} ${args.join(" ")}`) {
  const stepStarted = performance.now();
  log(`\n${"=".repeat(88)}`);
  log(label.toUpperCase());
  log(displayCommand);
  log("-".repeat(88));

  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    windowsHide: true,
  });

  if (result.stdout) log(result.stdout.trimEnd());
  if (result.stderr) log(result.stderr.trimEnd());
  if (result.error) log(`PROCESS ERROR: ${result.error.message}`);

  const exitCode = result.status ?? 1;
  const durationSeconds = (performance.now() - stepStarted) / 1000;
  results.push({ label, exitCode, durationSeconds });
  log(`RESULT: ${exitCode === 0 ? "PASS" : "FAIL"} (exit ${exitCode})`);
  log(`DURATION: ${durationSeconds.toFixed(1)}s`);
  return exitCode === 0;
}

function runPnpm(label, args) {
  const displayCommand = `pnpm ${args.join(" ")}`;
  if (pnpmCli) {
    return run(label, process.execPath, [pnpmCli, ...args], displayCommand);
  }
  return run(label, "pnpm", args, displayCommand);
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
  canValidate = runPnpm("Install dependencies", ["install", "--no-frozen-lockfile"]) && canValidate;
  const installChanges = workingTreeChangesWithoutLog();
  lockfileChanged = installChanges.some((line) => line.endsWith(` ${LOCK_FILE}`) || line.endsWith(` \"${LOCK_FILE}\"`));
  canValidate = record(
    "Dependency metadata diff check",
    isOnlyLockfileChange(installChanges),
    installChanges.length === 0 ? "lockfile already synchronized" : installChanges.join(" | "),
  ) && canValidate;

  canValidate = runPnpm("Typecheck", ["run", "typecheck"]) && canValidate;
  canValidate = runPnpm("Lint", ["run", "lint"]) && canValidate;

  if (hasPackageScript("test")) {
    canValidate = runPnpm("Tests", ["run", "test"]) && canValidate;
  } else {
    results.push({ label: "Tests", exitCode: 0, durationSeconds: 0, skipped: true });
    log("\nSKIP  Tests — no test script configured");
  }

  if (hasPackageScript("fallow")) {
    canValidate = runPnpm("Fallow audit", ["run", "fallow"]) && canValidate;
  } else if (existsSync("node_modules/.bin/fallow") || existsSync("node_modules/.bin/fallow.cmd")) {
    canValidate = runPnpm("Fallow audit", ["exec", "fallow"]) && canValidate;
  } else {
    results.push({ label: "Fallow audit", exitCode: 0, durationSeconds: 0, skipped: true });
    log("\nSKIP  Fallow audit — Fallow is not configured in this repository");
  }

  canValidate = runPnpm("Cloudflare production build", ["run", "cf:build"]) && canValidate;

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
