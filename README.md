# Daytona MCP

Private ChatGPT developer plugin that uses Daytona as an isolated execution/QA machine for GitHub repositories.

## Design

- One production Cloudflare Worker.
- One MCP endpoint: `/mcp`.
- One model-facing tool: `run_cycle`.
- No generic remote shell tool.
- GitHub remains the source of truth for code edits.
- Daytona clones the requested branch, runs one controlled shell script, reports the result, pushes the checked HEAD, and deletes the sandbox.

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

## Deploy

Authenticate Wrangler with your Cloudflare account once, then run:

```bash
pnpm install
pnpm run deploy
```

`pnpm run deploy` performs type checking and linting, builds Next.js for Cloudflare with OpenNext, then deploys the single production Worker.

## Connect the private ChatGPT plugin

Use the production HTTPS endpoint with your private MCP key in the stored URL:

```text
https://YOUR-DOMAIN/mcp?key=YOUR_MCP_API_KEY
```

The server also accepts `Authorization: Bearer <MCP_API_KEY>` for tools such as MCP Inspector. The query-string form exists because this is a private single-user plugin and ChatGPT does not send an arbitrary custom API-key header to remote MCP servers.

Treat the full plugin URL as a secret.

## `run_cycle`

Input:

- `repository` - repository name only; it must be present in `ALLOWED_GITHUB_REPOS`.
- `branch` - existing branch, default `main`.
- `timeout_seconds` - 60 to 3600 seconds, default 1200.

The single runner process:

1. Creates Git credentials with `GIT_ASKPASS` so the token is not embedded in the Git remote URL.
2. Clones exactly the requested branch.
3. Detects npm, pnpm, Yarn, or Bun from the repository lockfile.
4. Installs dependencies using the lockfile when one exists.
5. Runs configured `typecheck`, `lint`, and `test` scripts.
6. Runs Fallow when the repository has a `fallow` script or local Fallow binary.
7. Runs the configured `build` script.
8. Prints final Git status.
9. Pushes `HEAD` back to the same branch.
10. Returns the run log to ChatGPT and deletes the Daytona sandbox.

The runner does not create implementation commits or silently stage files produced by tests/builds. Source edits remain the responsibility of the GitHub API workflow.
