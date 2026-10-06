#!/bin/bash
# SessionStart hook for Claude Code cloud sessions: install what the typecheck, unit tests and
# Playwright e2e tests need. Idempotent and non-interactive; does nothing outside cloud sessions.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"

# Cloud sessions ship a matching Chromium in $PLAYWRIGHT_BROWSERS_PATH; don't download another copy in postinstall.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# `npm install` (not `npm ci`) so the container cache keeps node_modules between sessions.
npm install --no-audit --no-fund --loglevel=error

# Export (and the export tests) need ffmpeg/ffprobe on PATH. Usually preinstalled; try apt otherwise (best effort).
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    (apt-get update -qq && apt-get install -y -qq --no-install-recommends ffmpeg) >/dev/null 2>&1 \
      || echo "[session-start] ffmpeg is missing and could not be installed; export tests will fail." >&2
  else
    echo "[session-start] ffmpeg is missing; export tests will fail." >&2
  fi
fi
