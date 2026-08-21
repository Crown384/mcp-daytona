import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const API_URL = (process.env.DAYTONA_API_URL?.trim() || "https://app.daytona.io/api").replace(/\/$/, "");
const TOOLBOX_URL = "https://proxy.app.daytona.io/toolbox";
const REPOSITORY = "pamaos-next";
const BRANCH = "main";
const SNAPSHOT = "daytona-small";
const OWNER_PATTERN = /^[A-Za-z0-9_.-]+$/;
const FETCH_ATTEMPTS = 10;

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function loadRunnerScript() {
  const source = readFileSync(resolve("lib/runner.ts"), "utf8");
  const marker = "String.raw`";
  const start = source.indexOf(marker);
  const end = source.lastIndexOf("`;");
  if (start < 0 || end <= start) throw new Error("RUNNER_SCRIPT String.raw template could not be located");
  return source.slice(start + marker.length, end).replace(/\r\n?/g, "\n");
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function describeError(error) {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (!cause || typeof cause !== "object") return error.message;
  const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
  const message = "message" in cause && typeof cause.message === "string" ? cause.message : undefined;
  const detail = [code, message].filter(Boolean).join(": ");
  return detail ? `${error.message} (${detail})` : error.message;
}

async function fetchWithRetry(url, init, label) {
  let lastError;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.status !== 429 && response.status < 500) return response;
      if (attempt === FETCH_ATTEMPTS) return response;
      console.log(`${label}: HTTP ${response.status}; retrying (${attempt}/${FETCH_ATTEMPTS})...`);
    } catch (error) {
      lastError = error;
      if (attempt === FETCH_ATTEMPTS) break;
      console.log(`${label}: ${describeError(error)}; retrying (${attempt}/${FETCH_ATTEMPTS})...`);
    }

    await sleep(750 * attempt);
  }

  throw new Error(`${label} network request failed after ${FETCH_ATTEMPTS} attempts: ${describeError(lastError)}`);
}

const daytonaApiKey = requireEnv("DAYTONA_API_KEY");
const githubToken = requireEnv("GITHUB_TOKEN");
const githubOwner = requireEnv("GITHUB_OWNER");
if (!OWNER_PATTERN.test(githubOwner)) throw new Error("GITHUB_OWNER contains invalid characters");

async function daytona(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${daytonaApiKey}`);
  const response = await fetchWithRetry(`${API_URL}${path}`, { ...init, headers }, `Daytona ${path}`);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Daytona ${path} failed (${response.status}): ${text.slice(0, 1200)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function waitUntilStarted(sandboxId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const sandbox = await daytona(`/sandbox/${encodeURIComponent(sandboxId)}`);
    if (sandbox?.state === "started") return;
    await sleep(1000);
  }
  throw new Error(`Sandbox ${sandboxId} did not reach started state within 60 seconds`);
}

const runnerScript = loadRunnerScript();
const smokeCommand = [
  `git pull --ff-only origin ${BRANCH}`,
  "printf 'SMOKE_PULL=ok\\n'",
  "printf 'SMOKE_PWD=%s\\n' \"$PWD\"",
  "printf 'SMOKE_BRANCH=%s\\n' \"$(git branch --show-current)\"",
  "printf 'SMOKE_HEAD=%s\\n' \"$(git rev-parse HEAD)\"",
].join("; ");

let sandboxId;
let failure;

try {
  console.log(`Creating Daytona smoke-test sandbox (${SNAPSHOT})...`);
  const created = await daytona("/sandbox", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ snapshot: SNAPSHOT, ephemeral: true, autoStopInterval: 5 }),
  });

  if (!created || typeof created.id !== "string" || !created.id) {
    throw new Error("Daytona sandbox creation response did not include an id");
  }

  sandboxId = created.id;
  console.log(`SANDBOX_ID=${sandboxId}`);
  await waitUntilStarted(sandboxId);

  const encoded = Buffer.from(runnerScript, "utf8").toString("base64");
  const response = await fetchWithRetry(
    `${TOOLBOX_URL}/${encodeURIComponent(sandboxId)}/process/execute`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${daytonaApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        command: `printf '%s' '${encoded}' | base64 -d | bash`,
        cwd: ".",
        envs: {
          GITHUB_TOKEN: githubToken,
          GITHUB_OWNER: githubOwner,
          ACTION: "fresh",
          SYNC_MODE: "reset",
          REPOSITORY,
          BRANCH,
          COMMAND: smokeCommand,
          WORKING_PATH: ".",
        },
        timeout: 180,
      }),
    },
    "Daytona smoke runner",
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Daytona smoke runner failed (${response.status}): ${text.slice(0, 2000)}`);
  }

  const result = text ? JSON.parse(text) : {};
  if (typeof result.exitCode !== "number" || typeof result.result !== "string") {
    throw new Error("Daytona smoke runner response was missing exitCode or result");
  }

  process.stdout.write(result.result.endsWith("\n") ? result.result : `${result.result}\n`);
  if (result.exitCode !== 0) {
    throw new Error(`Daytona smoke runner failed with exit code ${result.exitCode}`);
  }
  if (!result.result.includes("== custom command ==")) {
    throw new Error("Daytona smoke did not execute the custom-command path");
  }
  if (!result.result.includes("path=.")) {
    throw new Error("Daytona smoke did not default the working path to repository root");
  }
  if (!result.result.includes("SMOKE_PULL=ok")) {
    throw new Error("Daytona smoke custom command could not run authenticated git pull");
  }
  if (!result.result.includes(`SMOKE_BRANCH=${BRANCH}`)) {
    throw new Error(`Daytona smoke did not checkout ${BRANCH}`);
  }
  if (!result.result.includes("SMOKE_HEAD=")) {
    throw new Error("Daytona smoke command did not report the checked-out commit");
  }

  console.log(`PASS runner cloned ${githubOwner}/${REPOSITORY}@${BRANCH}, authenticated git pull, and executed a root command`);
} catch (error) {
  failure = error;
  console.error(describeError(error));
} finally {
  if (sandboxId) {
    try {
      await daytona(`/sandbox/${encodeURIComponent(sandboxId)}`, { method: "DELETE" });
      console.log(`SANDBOX_DESTROYED=${sandboxId}`);
    } catch (cleanupError) {
      const message = describeError(cleanupError);
      console.error(`Sandbox cleanup failed: ${message}`);
      failure ??= new Error(`Smoke test cleanup failed: ${message}`);
    }
  }
}

if (failure) process.exit(1);
