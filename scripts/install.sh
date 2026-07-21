#!/usr/bin/env bash
# scripts/install.sh — build the cfsync CLI and install it as a single binary.
#
# Runs the same regardless of the caller's working directory; invoke it by any
# path. The install directory mirrors Go's GOBIN: it is $TSBIN when set, else
# ~/bin. The installed command name is $TSBIN_NAME when set, else "cfsync". So:
#
#   ./scripts/install.sh                        # -> ~/bin/cfsync
#   TSBIN=/usr/local/bin ./scripts/install.sh   # -> /usr/local/bin/cfsync
#   TSBIN_NAME=cf ./scripts/install.sh          # -> ~/bin/cf
#
# Bun is required to build; the compiled binary then runs standalone.

set -euo pipefail

NAME="${TSBIN_NAME:-cfsync}"
DEST="${TSBIN:-$HOME/bin}"

# Resolve the repository root from this script's own location (scripts/..), so
# the build runs correctly no matter where the caller invoked it from.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v bun >/dev/null 2>&1; then
    echo "install.sh: bun is required to build — see https://bun.sh" >&2
    exit 1
fi

echo "install.sh: building the cfsync CLI…"
bun install
bun run --filter '@cfsync/cli' build

BINARY="$ROOT/packages/cli/dist/cfsync"
if [ ! -x "$BINARY" ]; then
    echo "install.sh: build did not produce $BINARY" >&2
    exit 1
fi

mkdir -p "$DEST"
install -m 755 "$BINARY" "$DEST/$NAME"
echo "install.sh: installed $DEST/$NAME"

# Warn when the destination is not on PATH.
case ":$PATH:" in
    *":$DEST:"*) ;;
    *)
        echo "install.sh: note — $DEST is not on your PATH. Add it, e.g.:"
        echo "  export PATH=\"$DEST:\$PATH\""
        ;;
esac

# Warn when another command of the same name already shadows (or is shadowed by)
# this one, so the resolved command is not a surprise.
existing="$(command -v "$NAME" 2>/dev/null || true)"
if [ -n "$existing" ] && [ "$existing" != "$DEST/$NAME" ]; then
    echo "install.sh: note — '$NAME' also resolves to $existing;"
    echo "  PATH order decides which one runs."
fi

echo "install.sh: done. Try: $NAME version"
