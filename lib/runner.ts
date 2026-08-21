export const RUNNER_SCRIPT = String.raw`set -uo pipefail

STATUS=0
REPO_DIR="$HOME/workspace/repo"
ASKPASS="$HOME/.mcp-daytona-git-askpass"
REMOTE="https://github.com/$GITHUB_OWNER/$REPOSITORY.git"

cleanup() {
  rm -f "$ASKPASS"
}
trap cleanup EXIT

cat > "$ASKPASS" <<'EOF'
#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' 'x-access-token' ;;
  *) printf '%s\n' "$GITHUB_TOKEN" ;;
esac
EOF
chmod 700 "$ASKPASS"
export GIT_ASKPASS="$ASKPASS"
export GIT_TERMINAL_PROMPT=0

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

printf 'Daytona cycle: %s/%s @ %s\n' "$GITHUB_OWNER" "$REPOSITORY" "$BRANCH"
rm -rf "$REPO_DIR"
mkdir -p "$(dirname "$REPO_DIR")"

git clone --branch "$BRANCH" --single-branch "$REMOTE" "$REPO_DIR"
CLONE_CODE=$?
if [ "$CLONE_CODE" -ne 0 ]; then
  exit "$CLONE_CODE"
fi

cd "$REPO_DIR" || exit 1
printf 'Checked out: %s\n' "$(git rev-parse HEAD)"

if [ ! -f package.json ]; then
  printf '\nNo package.json found; skipping Node checks.\n'
else
  if [ -f pnpm-lock.yaml ]; then
    PACKAGE_MANAGER=pnpm
    corepack enable >/dev/null 2>&1 || true
    run_step install pnpm install --frozen-lockfile
  elif [ -f yarn.lock ]; then
    PACKAGE_MANAGER=yarn
    corepack enable >/dev/null 2>&1 || true
    if [ -f .yarnrc.yml ]; then
      run_step install yarn install --immutable
    else
      run_step install yarn install --frozen-lockfile
    fi
  elif [ -f bun.lock ] || [ -f bun.lockb ]; then
    PACKAGE_MANAGER=bun
    run_step install bun install --frozen-lockfile
  elif [ -f package-lock.json ]; then
    PACKAGE_MANAGER=npm
    run_step install npm ci
  else
    PACKAGE_MANAGER=npm
    run_step install npm install
  fi

  if [ "$STATUS" -eq 0 ]; then
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
  else
    printf '\nInstall failed; repository checks were skipped.\n'
  fi
fi

printf '\n== git status ==\n'
git status --short

printf '\n== push ==\n'
git push origin "HEAD:$BRANCH"
PUSH_CODE=$?
if [ "$PUSH_CODE" -ne 0 ] && [ "$STATUS" -eq 0 ]; then
  STATUS="$PUSH_CODE"
fi

printf '\n== cycle result ==\nexit_code=%s\n' "$STATUS"
exit "$STATUS"
`;
