# Daytona MCP

Private ChatGPT developer plugin that uses Daytona as an isolated execution/QA machine for GitHub repositories.

## Design

- One production Cloudflare Worker.
- One MCP endpoint: `/mcp`.
- No generic remote shell tool.
- GitHub remains the source of truth for implementation edits.
- Daytona sandboxes run one controlled runner script.
- Persistent sandboxes are explicitly labeled and lifecycle tools refuse unrelated Daytona sandboxes.

## Environment

Copy `.env.example` to `.env` for local Next.js work.

Cloudflare secrets:

- `DAYTONA_API_KEY`
- `GITHUB_TOKEN`
- `MCP_API_KEY`

Cloudflare variables:

- `DAYTONA_API_URL` (normally `https://app.daytona.io/api`)
- `DAYTONA_TARGET` (normally `us`)
- `GITHUB_OWNER`
- `ALLOWED_GITHUB_REPOS` (comma-separated repository names)

`wrangler.jsonc` uses `keep_vars: true`, so deployments preserve variables configured in the Cloudflare dashboard.

## Local validation workflow

After pulling the latest branch, run one command:

```bash
pnpm run validate:push
```

That single script:

1. verifies Git HEAD, branch, and a clean working tree;
2. installs dependencies from the lockfile;
3. runs TypeScript type checking and ESLint;
4. runs tests when a `test` script exists;
5. runs Fallow when it is configured;
6. builds the production Cloudflare/OpenNext bundle;
7. verifies the validation did not modify tracked source files;
8. writes the complete output and final PASS/FAIL summary to `mcp-daytona-validation.log`;
9. commits only that log file; and
10. pushes the log commit to the current branch.

The log is pushed on both passing and failing validation runs so it can be reviewed remotely. The script never stages or commits implementation changes.

After a passing validation log has been reviewed, deploy the already-built production bundle with:

```bash
pnpm run deploy
```

`pnpm run deploy` only publishes the existing `.open-next` production build; it does not repeat the validation/build cycle.

## Connect the private ChatGPT plugin

```text
https://YOUR-DOMAIN/mcp?key=YOUR_MCP_API_KEY
```

The server also accepts `Authorization: Bearer <MCP_API_KEY>` for MCP Inspector. Treat the full query-string plugin URL as a secret.

## Tools

### `run_cycle`

Creates a fresh managed sandbox and runs the repository cycle.

Inputs:

- `repository` - allowed repository name without the GitHub owner.
- `branch` - existing branch, default `main`.
- `timeout_seconds` - 60 to 3600, default 1200.
- `after_run` - `delete`, `keep`, `stop`, or `pause`.
- `snapshot` - `daytona-small`, `daytona-medium`, `daytona-large`, or the equivalent `daytona-vm-*` sizes.
- `auto_stop_minutes` - idle timeout; `0` keeps a running sandbox alive indefinitely.

`pause` requires a VM snapshot. `delete` creates an ephemeral sandbox. Other lifecycle modes create a persistent sandbox with auto-delete disabled.

### `rerun_cycle`

Reuses a persistent sandbox returned by `run_cycle`.

- Starts it automatically when it is stopped or paused.
- `sync_mode=reset` fetches the saved GitHub branch and hard-resets the checkout to `origin/<branch>` before running.
- `sync_mode=none` reruns the existing checkout as-is.
- `after_run` again supports `delete`, `keep`, `stop`, or `pause`.

The sandbox stores only its repository/branch context. GitHub credentials are supplied per runner invocation.

### Sandbox lifecycle tools

- `list_sandboxes` - list only sandboxes labeled as managed by this MCP.
- `get_sandbox` - inspect one managed sandbox.
- `manage_sandbox` - `start`, `stop`, `pause`, or `recover`.
- `configure_sandbox` - change `auto_stop`, `auto_pause`, or `auto_delete` intervals.
- `destroy_sandbox` - permanently delete a managed sandbox.

All lifecycle tools verify the `managed-by=mcp-daytona` label before acting.

## Single runner script

Every fresh run and rerun invokes the same runner script exactly once. It:

1. Clones the requested branch on a fresh run, or loads the saved checkout on a rerun.
2. Optionally fetches and hard-resets a persistent checkout to the latest GitHub branch.
3. Detects npm, pnpm, Yarn, or Bun from the lockfile.
4. Installs dependencies using the lockfile when available.
5. Runs configured `typecheck`, `lint`, and `test` scripts.
6. Runs Fallow when configured.
7. Runs the repository `build` script when configured.
8. Prints final Git status.
9. Pushes the checked `HEAD` back to the same branch.
10. Returns the log to ChatGPT.

The GitHub token is not exported to repository scripts. It is kept as a non-exported shell variable and only materialized into temporary `GIT_ASKPASS` files during Git network operations; those files are deleted immediately afterward.

The runner never stages or commits implementation files. Source changes remain the responsibility of the GitHub API workflow.
