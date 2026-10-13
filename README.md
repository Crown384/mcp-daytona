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

Before Env Store is configured, the original MCP tools are available without a separate caller bearer (the endpoint must still be secured at the network/host layer). **Once any Pama Env Store setting is configured on the Worker, EVERY sandbox operation requires the `PAMA_ENV_STORE_MCP_AUTH_TOKEN` bearer credential**, including list/get/rerun/manage/configure/destroy; a partially configured integration fails closed. This is one shared service identity, not per-user authorization. Do not distribute its bearer token to mutually untrusted users. An external authenticated gateway is still recommended.

After deploying a tool-schema change, refresh/reconnect the ChatGPT MCP connection so clients stop using cached tool metadata.

## Scoped MCP client identities (LDT-68)

The optional `PAMA_ENV_STORE_MCP_CLIENTS_JSON` Worker **secret** enables per-client service principals. Use an array of records with `id` (stable unique lowercase slug), `tokenSha256` (SHA-256 hex of a **random 32+ character bearer**), `enabled` (boolean), `repositories` (exact lowercase `owner/repo` entries), `projects` (allowed Env Store project slugs), and `environments` (subset of `["staging","production"]`). Never store raw client tokens in the JSON. A client without project/environment scope may still work on its allowed repositories without secrets. The global production and `PAMA_ENV_STORE_TRUSTED_REPOS` controls remain in effect.

When this variable is **present**, even empty or malformed, the server fails closed: **all sandbox tool calls require a matching enabled principal token**, and the old shared bearer is rejected. Every newly created sandbox is labeled with the caller's principal ID, and list/get/rerun/manage/configure/destroy check matching ownership and allowed repository. Existing unlabeled sandboxes are intentionally inaccessible through the new scoped control plane. `initialize` and `tools/list` continue advertising public schemas only; no sandbox data is exposed by those methods. Control actions emit sanitized principal ID, tool name and outcome to the Worker log, without secret values.

**Safe migration:** enumerate and delete old unowned sandboxes before switching modes, or complete their work using the old trusted single-user endpoint; do not share the legacy bearer across different users. Create uniquely identifiable hashed principals, supply each caller's raw bearer only through its secure MCP connection configuration, and then configure the Worker secret. If migration must be reversible, restore the prior Worker secret configuration only after verifying no secret-bearing sandboxes are accessible to another identity. To rotate, provision a second record with a new ID/token hash, migrate the client connection, then disable/remove the old record. To revoke, set `enabled:false` or remove the record and update the Worker secret; callers are denied after the deployment picks up that new configuration. Do not reuse IDs across different owners.

For a locally generated bearer available as `MCP_CLIENT_BEARER` in the **trusted operator shell**, compute its digest without printing the bearer:

```sh
node -e 'const c=require("node:crypto");if(!process.env.MCP_CLIENT_BEARER)process.exit(1);console.log(c.createHash("sha256").update(process.env.MCP_CLIENT_BEARER).digest("hex"))'
```

This is scoped **service-principal bearer authorization**, not a complete OAuth authorization-server implementation. For public/multi-tenant distribution, implement the MCP HTTP OAuth 2.1 protected-resource metadata/token validation flow and durable principal identities. The Daytona organization-level API key still has broad authority outside this MCP; real sandbox egress/isolation and deletion-failure checks remain necessary before using production deploy keys.

## Secure Env Store integration (optional)

Daytona MCP can now fetch a project/environment from Pama Env Store **on the Worker**, without placing the secret in the MCP request or a generated shell command. The machine token is only configured as a Cloudflare Worker secret, never as an MCP tool argument:

- `PAMA_ENV_STORE_URL` — HTTPS **Next.js Env Store website** origin (e.g. `https://env-store.example.com`); this is **not** the Convex cloud URL.
- `PAMA_ENV_STORE_TOKEN` — one-time `pes_...` machine token created in Env Store and securely set using Cloudflare Worker secret management.
- `PAMA_ENV_STORE_MCP_AUTH_TOKEN` — **separate 32+ character bearer secret** required from the MCP caller for **every sandbox tool call when any Env Store setting is configured on the Worker**. Configure on the Worker, and configure the MCP client to supply `Authorization: Bearer <caller token>` using its supported authentication mechanism.
- `PAMA_ENV_STORE_ALLOW_PRODUCTION=true` — optional explicit production opt-in. Default is denied.
- `PAMA_ENV_STORE_TRUSTED_REPOS` — **required for secret-bearing runs only**. Comma-separated exact `owner/repo` identities, e.g. `Crown384/track, PAMA-Ltd/pamastore`. No wildcards or prefix matches; the service refuses secret access if unset or malformed. Nonsecret GitHub operations remain unrestricted.

Create a dedicated Env Store machine client with access only to the required projects and environments. Configure these Worker secrets out-of-band before deployment. If your ChatGPT MCP connection cannot supply the caller bearer securely, secret-enabled tools will fail closed; do not bypass authentication by making the Worker token public. Env Store must be deployed with a working Convex backend first.

Pass both `env_store_project` (its slug) and `env_store_environment` (`staging` or `production`) on `run_cycle` or `rerun_cycle`. No secret values or machine tokens belong in these tool parameters. The Worker requests `GET /api/projects/{slug}/env/{environment}` with its bearer credential over HTTPS, validates the response, refuses reserved runner environment names, then injects approved values through Daytona's **per-execution process environment**. The values are not saved to the checkout or automatically persisted in the sandbox. The machine credential is not forwarded to Daytona, and no secret values are returned by the MCP API. When any Env Store configuration exists on the Worker, **ALL sandbox tools** (including list/get, rerun, configure, manage, and destroy) require the configured caller bearer; partial configuration fails closed. Public non-secret operation is only retained before *any* secret-store integration is configured. Protect the entire endpoint with a separate authenticated gateway too. Treat the caller token as a single shared service identity; do not share it across untrusted users. Normal calls without these optional parameters work as before.

**Secret-enabled executions are disposable by design.** When passing `env_store_project`/`env_store_environment`, set `after_run=delete` (the default on fresh cycles); `keep`, `stop`, and `pause` are refused for both fresh and rerun cycles. The trusted-repository policy is enforced on the backend before fetching Env Store values or provisioning a fresh sandbox; reruns resolve the repository from verified managed sandbox labels rather than caller input. This is an intentional restriction that may require adapting persistent-sandbox automation. Cleanup may fail due to upstream outages, so configure Daytona organization-level sandbox lifetimes and verify actual deletion in the live smoke. A caller with access to a secret-bearing execution can still maliciously exfiltrate credentials over the network or cause concurrent inspection; trusted repositories and ephemeral lifecycle are **not** equivalent to sandbox egress or tenant isolation. Those controls remain separately required under LDT-68 and LDT-69.

Successful runner output is redacted for exact secret values (including URL encoding). Upstream Daytona HTTP **error bodies are discarded entirely** before constructing a caller-visible status-only error, preventing partial-secret leaks at output truncation boundaries. **This is defense in depth, not a complete data-loss-prevention boundary.** Arbitrary shell commands or malicious repository scripts running with secret access can encode, transmit, or otherwise exfiltrate secrets. Limit the machine token to staging whenever possible, use trustworthy repositories/commands, restrict egress on sensitive sandboxes, and rotate credentials. Production use requires explicit permission and security review.

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
