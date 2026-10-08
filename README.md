# Daytona MCP

Private ChatGPT developer plugin that uses Daytona as an isolated execution/QA machine for GitHub repositories.

## Design

- One production Cloudflare Worker.
- One MCP endpoint: `/mcp`.
- GitHub remains the source of truth for implementation edits.
- Daytona sandboxes run one controlled runner script.
- Persistent sandboxes are explicitly labeled and lifecycle tools refuse unrelated Daytona sandboxes.
- GitHub App installation tokens are minted per repository, so repositories can belong to different users or organizations.

## Environment

Copy `.env.example` to `.env.local` for local work.

Required:

- `DAYTONA_API_KEY`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY_BASE64`

Optional:

- `DAYTONA_API_URL` (normally `https://app.daytona.io/api`)

`GITHUB_APP_PRIVATE_KEY_BASE64` is the base64 encoding of the complete GitHub App `.pem` file. Both `BEGIN RSA PRIVATE KEY` and `BEGIN PRIVATE KEY` PEM formats are supported.

The same GitHub App can be installed on multiple accounts or organizations. `run_cycle` requires repositories in full `owner/repo` form and automatically resolves the correct installation and mints a short-lived installation token scoped to that repository. Bare repository names are rejected.

The MCP does not force a Daytona region. Sandbox creation omits the `target` field so Daytona can schedule the sandbox in a region available to the organization.

## Local validation workflow

After pulling the latest branch, run:

```bash
pnpm run validate
```

Validation performs local code checks, verifies GitHub App access to the configured smoke repositories, runs a live Daytona clone/pull smoke test, builds the Cloudflare/OpenNext production bundle, writes `mcp-daytona-validation.log`, and pushes only the validation artifact.

After a passing validation log has been reviewed, deploy with:

```bash
pnpm run deploy
```

## Connect the private ChatGPT plugin

Use the production MCP endpoint:

```text
https://daytona-mcp.pama.company/mcp
```

No custom MCP API-key layer is implemented.

After deploying a tool-schema change, refresh/reconnect the ChatGPT MCP connection so clients stop using cached tool metadata.

## Secure Env Store integration (optional)

Daytona MCP can now fetch a project/environment from Pama Env Store **on the Worker**, without placing the secret in the MCP request or a generated shell command. The machine token is only configured as a Cloudflare Worker secret, never as an MCP tool argument:

- `PAMA_ENV_STORE_URL` — HTTPS **Next.js Env Store website** origin (e.g. `https://env-store.example.com`); this is **not** the Convex cloud URL.
- `PAMA_ENV_STORE_TOKEN` — one-time `pes_...` machine token created in Env Store and securely set using Cloudflare Worker secret management.
- `PAMA_ENV_STORE_ALLOW_PRODUCTION=true` — optional explicit production opt-in. Default is denied.

Create a dedicated Env Store machine client with access only to the required projects and environments. Configure these Worker secrets out-of-band before deployment. Env Store must be deployed with a working Convex backend first.

Pass both `env_store_project` (its slug) and `env_store_environment` (`staging` or `production`) on `run_cycle` or `rerun_cycle`. No secret values or machine tokens belong in these tool parameters. The Worker requests `GET /api/projects/{slug}/env/{environment}` with its bearer credential over HTTPS, validates the response, refuses reserved runner environment names, then injects approved values through Daytona's **per-execution process environment**. The values are not saved to the checkout or automatically persisted in the sandbox. The machine credential is not forwarded to Daytona, and no secret values are returned by the MCP API. Normal calls without these optional parameters work as before.

The runner output is redacted for exact secret values (including URL encoding). **This is defense in depth, not a complete data-loss-prevention boundary.** Arbitrary shell commands or malicious repository scripts running with secret access can encode, transmit, or otherwise exfiltrate secrets. Limit the machine token to staging whenever possible, use trustworthy repositories/commands, restrict egress on sensitive sandboxes, and rotate credentials. Production use requires explicit permission and security review.

## Tools

### `run_cycle`

Creates a fresh managed sandbox and runs the repository cycle.

Important inputs:

- `repository` — required full GitHub repository in `owner/repo` form, for example `Crown384/pamaos-next` or `Onestepsmarter/afri_cart`.
- `branch` — existing branch, default `main`.
- `command` — optional arbitrary shell command; when omitted, the standard QA pipeline runs.
- `path` — optional repository-relative initial working directory, default `.`.
- `timeout_seconds` — 60 to 3600, default 1200.
- `after_run` — `delete`, `keep`, `stop`, or `pause`.
- `snapshot` — container sizes `daytona-small|medium|large` or VM sizes `daytona-vm-small|medium|large`.
- `auto_stop_minutes` — idle timeout; `0` disables auto-stop.

`pause` requires a VM snapshot. Container sandboxes should use `stop` and later `start`.

### `rerun_cycle`

Reuses a persistent sandbox returned by `run_cycle`.

- A fresh GitHub App installation token is minted for the sandbox repository on each rerun.
- `sync_mode=reset` fetches and hard-resets to the saved branch.
- `sync_mode=none` keeps the existing checkout as-is.
- `after_run` supports `delete`, `keep`, `stop`, or `pause`.

### Sandbox lifecycle tools

- `list_sandboxes`
- `get_sandbox`
- `manage_sandbox` — `start`, `stop`, `pause`, or `recover`
- `configure_sandbox`
- `destroy_sandbox`

All lifecycle tools verify the `managed-by=mcp-daytona` label before acting.

## Runner behavior

Every fresh run and rerun invokes the same runner script once. It clones or reuses the checkout, optionally syncs Git, runs the requested arbitrary command or the standard QA pipeline, and returns logs.

GitHub credentials are supplied only for the current runner invocation. The installation token is removed from `GITHUB_TOKEN` before repository commands run and is exposed to Git only through temporary `GIT_ASKPASS` files that are deleted afterward. Nested commands such as `git pull`, `git commit`, and `git push` can authenticate through that temporary Git credential context.

The runner itself does not automatically stage, commit, or push source changes. Arbitrary commands may do so when explicitly requested and when the GitHub App installation has the required repository permissions.
