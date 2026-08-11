#!/usr/bin/env bash
#
# Collect Computer-Use QA screenshots WHILE a pass runs.
#
# Why this exists
# ---------------
# QA round 2 produced 19 screenshots, verified non-empty during the run, and
# lost every one of them. The chain:
#
#   1. The Computer Use helper cannot write under ~/Projects (EPERM — a macOS
#      privacy restriction on that process, not a Codex sandbox setting).
#   2. It could not write to /tmp/devgame-qa2/ either, same EPERM.
#   3. It fell back to its own directory under
#      $TMPDIR/com.openai.sky.CUAService/ and reported that, which is what the
#      handoff asked for.
#   4. That directory was purged before anyone collected from it. Round 1's
#      captures survived there; round 2's window was empty afterwards, and a
#      find across /var/folders for that mtime window returned nothing.
#
# The fallback saved the RUN but not the EVIDENCE. Telling the driver to
# "verify the first screenshot wrote" does not help: round 2 did verify, and
# the files still vanished. **Persistence is the property that matters, not
# creation** — so copy them out continuously rather than once at the end.
#
# Usage
# -----
#   scripts/qa/collect-cua-screenshots.sh evidence/qa-round3/screenshots &
#   COLLECTOR=$!
#   ... run the QA pass ...
#   kill "$COLLECTOR"
#
# Runs until killed. Copies each new file once, never overwrites, and leaves
# the originals alone so the driver's own bookkeeping still works.

set -euo pipefail

DEST="${1:-}"
if [ -z "$DEST" ]; then
  echo "usage: $0 <destination-dir> [poll-seconds]" >&2
  exit 2
fi
POLL="${2:-3}"

# The helper writes under the per-user temp dir. TMPDIR carries the trailing
# slash on macOS, hence the parameter expansion rather than a bare append.
SRC="${TMPDIR%/}/com.openai.sky.CUAService"

mkdir -p "$DEST"

if [ ! -d "$SRC" ]; then
  # Not fatal: the directory is created lazily on the helper's first capture.
  # Warn once and keep polling, so the collector can be started BEFORE the run.
  echo "collect-cua-screenshots: waiting for $SRC to appear" >&2
fi

echo "collect-cua-screenshots: $SRC -> $DEST (polling every ${POLL}s)" >&2

copied=0
while true; do
  if [ -d "$SRC" ]; then
    # -maxdepth 1: the helper also creates numbered subdirectories that hold
    # duplicates of images already written at the top level. Recursing would
    # collect each capture twice under two different names.
    while IFS= read -r -d '' f; do
      base="$(basename "$f")"
      if [ ! -e "$DEST/$base" ]; then
        # cp, never mv: moving them out from under a live driver would break
        # its own verification reads and any path it reported in its notes.
        if cp -p "$f" "$DEST/$base" 2>/dev/null; then
          copied=$((copied + 1))
          echo "collect-cua-screenshots: [$copied] $base" >&2
        fi
      fi
    done < <(find "$SRC" -maxdepth 1 -type f \( -name '*.png' -o -name '*.jpeg' -o -name '*.jpg' \) -print0 2>/dev/null)
  fi
  sleep "$POLL"
done
