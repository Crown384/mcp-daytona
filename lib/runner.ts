export const RUNNER_SCRIPT = String.raw`set -uo pipefail

STATUS=0
ACTION="$(printenv ACTION 2>/dev/null || true)"
SYNC_MODE="$(printenv SYNC_MODE 2>/dev/null || true)"
GITHUB_OWNER="$(printenv GITHUB_OWNER 2>/dev/null || true)"
TOKEN_SECRET="$(printenv GITHUB_TOKEN 2>/dev/null || true)"
REPO_DIR="$HOME/workspace/repo"
CONTEXT_FILE="$HOME/.mcp-daytona-context"

[ -n "$ACTION" ] || ACTION="fresh"
[ -n "$SYNC_MODE" ] || SYNC_MODE="reset"

if [ -z "$TOKEN_SECRET" ]; then
  printf 'Missing runner environment variable: GITHUB_TOKEN\n'
  exit 2
fi
if [ -z "$GITHUB_OWNER" ]; then
  printf 'Missing runner environment variable: GITHUB_OWNER\n'
  exit 2
fi

unset GITHUB_TOKEN
export GIT_TERMINAL_PROMPT=0

with_git_auth() (
  TOKEN_FILE="$(mktemp)" || exit 1
  ASKPASS="$(mktemp)" || { rm -f "$TOKEN_FILE"; exit 1; }
  trap 'rm -f "$ASKPASS" "$TOKEN_FILE"' EXIT

  printf '%s' "$TOKEN_SECRET" > "$TOKEN_FILE" || exit 1
  chmod 600 "$TOKEN_FILE" || exit 1
  cat > "$ASKPASS" <<EOF
#!/bin/sh
case "\$1" in
  *Username*) printf '%s\n' "$GITHUB_OWNER" ;;
  *) cat "$TOKEN_FILE"; printf '\n' ;;
esac
EOF
  chmod 700 "$ASKPASS" || exit 1
  GIT_ASKPASS="$ASKPASS" "$@"
)

run_step() {
  LABEL="$1"
  shift
  printf '\n== %s ==\n' "$LABEL"
  "$@"
  CODE=$?
  if [ "$CODE" -ne 0 ] && [ "$STATUS" -eq 0 ]; then
    STATUS="$CODE"
  fi
  return 0
}

prepare_corepack() {
  if ! command -v corepack >/dev/null 2>&1; then
    run_step corepack npm install --global corepack
  fi
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
  fi
}

has_script() {
  node -e 'const p=require("./package.json"); process.exit(Object.prototype.hasOwnProperty.call(p.scripts || {}, process.argv[1]) ? 0 : 1)' "$1"
}

run_script() {
  SCRIPT_NAME="$1"
  case "$PACKAGE_MANAGER" in
    pnpm) run_step "$SCRIPT_NAME" pnpm run "$SCRIPT_NAME" ;;
    yarn) run_step "$SCRIPT_NAME" yarn run "$SCRIPT_NAME" ;;
    bun) run_step "$SCRIPT_NAME" bun run "$SCRIPT_NAME" ;;
    *) run_step "$SCRIPT_NAME" npm run "$SCRIPT_NAME" ;;
  esac
}

fresh_checkout() {
  REPOSITORY="$(printenv REPOSITORY 2>/dev/null || true)"
  BRANCH="$(printenv BRANCH 2>/dev/null || true)"
  if [ -z "$REPOSITORY" ]; then
    printf 'Missing runner environment variable: REPOSITORY\n'
    return 2
  fi
  if [ -z "$BRANCH" ]; then
    printf 'Missing runner environment variable: BRANCH\n'
    return 2
  fi

  REMOTE="https://github.com/$GITHUB_OWNER/$REPOSITORY.git"
  rm -rf "$REPO_DIR"
  mkdir -p "$(dirname "$REPO_DIR")"
  with_git_auth git clone --branch "$BRANCH" --single-branch "$REMOTE" "$REPO_DIR" || return $?
  printf '%s\n%s\n%s\n' "$GITHUB_OWNER" "$REPOSITORY" "$BRANCH" > "$CONTEXT_FILE"
  chmod 600 "$CONTEXT_FILE"
}

load_context() {
  if [ ! -f "$CONTEXT_FILE" ] || [ ! -d "$REPO_DIR/.git" ]; then
    printf 'Persistent sandbox has no Daytona MCP checkout context.\n'
    return 1
  fi
  SAVED_OWNER="$(sed -n '1p' "$CONTEXT_FILE")"
  REPOSITORY="$(sed -n '2p' "$CONTEXT_FILE")"
  BRANCH="$(sed -n '3p' "$CONTEXT_FILE")"
  if [ "$SAVED_OWNER" != "$GITHUB_OWNER" ] || [ -z "$REPOSITORY" ] || [ -z "$BRANCH" ]; then
    printf 'Persistent sandbox checkout context is invalid.\n'
    return 1
  fi
}

sync_checkout() {
  case "$SYNC_MODE" in
    none) return 0 ;;
    reset) ;;
    *)
      printf 'Unsupported sync mode: %s\n' "$SYNC_MODE"
      return 2
      ;;
  esac

  cd "$REPO_DIR" || return 1
  printf '\n== sync latest GitHub branch ==\n'
  with_git_auth git fetch origin "$BRANCH" || return $?
  git reset --hard "origin/$BRANCH" || return $?
}

install_dependencies() {
  if [ -f pnpm-lock.yaml ]; then
    PACKAGE_MANAGER=pnpm
    command -v pnpm >/dev/null 2>&1 || prepare_corepack
    run_step install env CI=true pnpm install --frozen-lockfile
  elif [ -f yarn.lock ]; then
    PACKAGE_MANAGER=yarn
    command -v yarn >/dev/null 2>&1 || prepare_corepack
    if [ -f .yarnrc.yml ]; then
      run_step install env CI=true yarn install --immutable
    else
      run_step install env CI=true yarn install --frozen-lockfile
    fi
  elif [ -f bun.lock ] || [ -f bun.lockb ]; then
    PACKAGE_MANAGER=bun
    run_step install env CI=true bun install --frozen-lockfile
  elif [ -f package-lock.json ]; then
    PACKAGE_MANAGER=npm
    run_step install env CI=true npm ci
  else
    PACKAGE_MANAGER=npm
    run_step install env CI=true npm install --package-lock=false
  fi
}

run_repository_checks() {
  for SCRIPT_NAME in typecheck lint test; do
    if has_script "$SCRIPT_NAME"; then
      run_script "$SCRIPT_NAME"
    fi
  done

  if has_script fallow; then
    run_script fallow
  elif [ -x node_modules/.bin/fallow ]; then
    run_step fallow ./node_modules/.bin/fallow
  else
    printf '\n== fallow ==\nskipped (not configured in this repository)\n'
  fi

  if has_script build; then
    run_script build
  fi
}

if [ "$ACTION" = "fresh" ]; then
  fresh_checkout || exit $?
elif [ "$ACTION" = "rerun" ]; then
  load_context || exit $?
  sync_checkout || exit $?
else
  printf 'Unsupported runner action: %s\n' "$ACTION"
  exit 2
fi

cd "$REPO_DIR" || exit 1
printf 'Daytona cycle: %s/%s @ %s\n' "$GITHUB_OWNER" "$REPOSITORY" "$BRANCH"
printf 'Checked out: %s\n' "$(git rev-parse HEAD)"

if [ ! -f package.json ]; then
  printf '\nNo package.json found; skipping Node checks.\n'
else
  install_dependencies
  if [ "$STATUS" -eq 0 ]; then
    run_repository_checks
  else
    printf '\nInstall failed; repository checks were skipped.\n'
  fi
fi

printf '\n== git status ==\n'
GIT_STATUS="$(git status --porcelain)"
if [ -n "$GIT_STATUS" ]; then
  printf '%s\n' "$GIT_STATUS"
  printf 'Repository working tree changed during the QA cycle.\n'
  if [ "$STATUS" -eq 0 ]; then
    STATUS=3
  fi
else
  printf 'clean\n'
fi

printf '\n== cycle result ==\nexit_code=%s\n' "$STATUS"
exit "$STATUS"
`;