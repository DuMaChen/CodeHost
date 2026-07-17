#!/bin/sh
set -eu

step="${1:-${PLATFORM_WORKFLOW_STEP:-}}"
work="${PLATFORM_WORK_ROOT:-/work}"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

fetch_source() {
  token_file="/var/run/platform/source/token"
  [ -r "$token_file" ] || fail "source credential is unavailable"
  [ -n "${PLATFORM_GITEA_BASE_URL:-}" ] || fail "Gitea base URL is unavailable"
  [ -n "${PLATFORM_REPOSITORY:-}" ] || fail "repository is unavailable"
  [ -n "${PLATFORM_PULL_REQUEST:-}" ] || fail "pull request number is unavailable"

  rm -rf "$work/source"
  # The analyze Job mounts an output emptyDir below the read-only workspace.
  # Create its mountpoint while fetch still has the PVC read-write.
  mkdir -p "$work/source" "$work/analysis-output" /tmp/platform-git
  cat > /tmp/platform-git/askpass <<'EOF'
#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' oauth2 ;;
  *Password*) cat /var/run/platform/source/token ;;
  *) exit 1 ;;
esac
EOF
  chmod 0700 /tmp/platform-git/askpass
  export GIT_ASKPASS=/tmp/platform-git/askpass
  export GIT_TERMINAL_PROMPT=0
  git -C "$work/source" init --quiet
  git -C "$work/source" remote add origin "${PLATFORM_GITEA_BASE_URL%/}/${PLATFORM_REPOSITORY}.git"
  git -C "$work/source" fetch --quiet --depth=1 origin "pull/${PLATFORM_PULL_REQUEST}/head"
  git -C "$work/source" checkout --quiet --detach FETCH_HEAD
  rm -rf "$work/source/.git" /tmp/platform-git
}

analyze() {
  mkdir -p "$work/analysis-output"
  : > "$work/analysis-output/summary.txt"
  command -v gitleaks >/dev/null 2>&1 || fail "gitleaks is unavailable"
  gitleaks_stdout="/tmp/gitleaks.stdout"
  gitleaks_stderr="/tmp/gitleaks.stderr"
  if gitleaks detect --source "$work/source" --no-banner --redact --report-format json --report-path "$work/analysis-output/gitleaks.json" >"$gitleaks_stdout" 2>"$gitleaks_stderr"; then
    printf '%s\n' 'gitleaks passed with redacted output' >> "$work/analysis-output/summary.txt"
  else
    rm -f "$gitleaks_stdout" "$gitleaks_stderr"
    if [ -s "$work/analysis-output/gitleaks.json" ]; then
      printf '%s\n' 'gitleaks detected a secret; see the redacted report' >> "$work/analysis-output/summary.txt"
      cat "$work/analysis-output/summary.txt"
      exit 1
    fi
    fail "gitleaks execution failed"
  fi
  rm -f "$gitleaks_stdout" "$gitleaks_stderr"
  find "$work/source" -type f -name '*.json' -size -1M -print | while IFS= read -r file; do
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$file" >/dev/null 2>&1 || printf 'json-check-failed: %s\n' "${file#"$work/source/"}" >> "$work/analysis-output/summary.txt"
  done
  cat "$work/analysis-output/summary.txt"
}

fixed_checks() {
  [ -d "$work/source" ] || fail "source workspace is unavailable"
  project_type="${PLATFORM_PROJECT_TYPE:-}"
  project_profile="${PLATFORM_PROJECT_PROFILE:-}"
  if [ -n "$project_type" ] && [ "$project_type" != "node" ] && [ "$project_type" != "python" ]; then
    fail "unsupported detected project type"
  fi
  if [ -n "$project_profile" ] && [ "$project_profile" != "node-http" ] && [ "$project_profile" != "python-http" ]; then
    fail "unsupported detected project profile"
  fi
  if [ "$project_type" = "node" ] && [ "$project_profile" != "node-http" ]; then
    fail "detected Node project has an inconsistent profile"
  fi
  if [ "$project_type" = "python" ] && [ "$project_profile" != "python-http" ]; then
    fail "detected Python project has an inconsistent profile"
  fi
  if [ "$project_type" = "node" ] || { [ -z "$project_type" ] && [ -f "$work/source/package.json" ]; }; then
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$work/source/package.json" >/dev/null 2>&1 || fail "package metadata is invalid"
    find "$work/source" -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) -size -2M -print | while IFS= read -r file; do
      node --check "$file" >/dev/null 2>&1 || fail "Node syntax check failed"
    done
    if find "$work/source" -type f \( -name 'test-*.js' -o -name '*.test.js' -o -name '*.test.mjs' -o -name '*.test.cjs' \) -print | grep -q .; then
      if ! (cd "$work/source" && node --test --test-concurrency=1) >/tmp/platform-node-test.log 2>&1; then
        cat /tmp/platform-node-test.log >&2
        fail "Node fixed tests failed"
      fi
    fi
  elif [ "$project_type" = "python" ] || { [ -z "$project_type" ] && find "$work/source" -maxdepth 2 -type f \( -name '*.py' -o -name 'pyproject.toml' \) | grep -q .; }; then
    python3 -m compileall -q "$work/source" || fail "Python syntax check failed"
    if find "$work/source" -type f -name 'test_*.py' -print | grep -q .; then
      if ! python3 -m unittest discover -s "$work/source" -p 'test_*.py' >/tmp/platform-python-test.log 2>&1; then
        cat /tmp/platform-python-test.log >&2
        fail "Python fixed tests failed"
      fi
    fi
  else
    fail "unsupported fixed project profile"
  fi
}

case "$step" in
  fetch) fetch_source ;;
  analyze) analyze ;;
  build-test|test|build) fixed_checks ;;
  *) fail "unsupported platform workflow step" ;;
esac
