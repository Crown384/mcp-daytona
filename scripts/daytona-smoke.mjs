const API_URL = (process.env.DAYTONA_API_URL?.trim() || "https://app.daytona.io/api").replace(/\/$/, "");
const TOOLBOX_URL = "https://proxy.app.daytona.io/toolbox";
const REPOSITORY = "pamaos-next";
const BRANCH = "main";
const SNAPSHOT = "daytona-small";
const OWNER_PATTERN = /^[A-Za-z0-9_.-]+$/;

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const daytonaApiKey = requireEnv("DAYTONA_API_KEY");
const githubToken = requireEnv("GITHUB_TOKEN");
const githubOwner = requireEnv("GITHUB_OWNER");
if (!OWNER_PATTERN.test(githubOwner)) throw new Error("GITHUB_OWNER contains invalid characters");

async function daytona(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${daytonaApiKey}`);
  const response = await fetch(`${API_URL}${path}`, { ...init, headers });
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
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Sandbox ${sandboxId} did not reach started state within 60 seconds`);
}

const smokeScript = [
  "set -euo pipefail",
  'TOKEN_SECRET="$GITHUB_TOKEN"',
  "unset GITHUB_TOKEN",
  "export GIT_TERMINAL_PROMPT=0",
  'TOKEN_FILE="$(mktemp)"',
  'ASKPASS="$(mktemp)"',
  "trap 'rm -f \"$ASKPASS\" \"$TOKEN_FILE\"' EXIT",
  'printf "%s" "$TOKEN_SECRET" > "$TOKEN_FILE"',
  'chmod 600 "$TOKEN_FILE"',
  'cat > "$ASKPASS" <<EOF',
  "#!/bin/sh",
  'case "\\$1" in',
  `  *Username*) printf '%s\\n' '${githubOwner}' ;;`,
  '  *) cat "$TOKEN_FILE"; printf "\\n" ;;',
  "esac",
  "EOF",
  'chmod 700 "$ASKPASS"',
  'rm -rf "$HOME/pamaos-next-smoke"',
  'GIT_ASKPASS="$ASKPASS" git clone --branch "$BRANCH" --single-branch "https://github.com/$GITHUB_OWNER/$REPOSITORY.git" "$HOME/pamaos-next-smoke"',
  'cd "$HOME/pamaos-next-smoke"',
  'printf "CLONED_HEAD=%s\\n" "$(git rev-parse HEAD)"',
  'printf "CLONED_BRANCH=%s\\n" "$(git branch --show-current)"',
].join("\n");

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

  const encoded = Buffer.from(smokeScript, "utf8").toString("base64");
  const response = await fetch(`${TOOLBOX_URL}/${encodeURIComponent(sandboxId)}/process/execute`, {
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
        REPOSITORY,
        BRANCH,
      },
      timeout: 180,
    }),
  });

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
    throw new Error(`Daytona smoke clone failed with exit code ${result.exitCode}`);
  }

  if (!result.result.includes("CLONED_HEAD=")) {
    throw new Error("Daytona smoke clone did not report a checked-out commit");
  }
  if (!result.result.includes(`CLONED_BRANCH=${BRANCH}`)) {
    throw new Error(`Daytona smoke clone did not checkout ${BRANCH}`);
  }

  console.log(`PASS cloned ${githubOwner}/${REPOSITORY}@${BRANCH}`);
} catch (error) {
  failure = error;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  if (sandboxId) {
    try {
      await daytona(`/sandbox/${encodeURIComponent(sandboxId)}`, { method: "DELETE" });
      console.log(`SANDBOX_DESTROYED=${sandboxId}`);
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.error(`Sandbox cleanup failed: ${message}`);
      failure ??= new Error(`Smoke test cleanup failed: ${message}`);
    }
  }
}

if (failure) process.exit(1);
