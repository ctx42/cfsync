#!/usr/bin/env bash
# deploy-local.sh — deploy the built cfsync Obsidian plugin into a local vault.
#
# Places the plugin's three shipping files — main.js, manifest.json, styles.css
# — into <vault>/.obsidian/plugins/<id>/, the exact layout an end user's manual
# install produces. Builds first unless told not to. The plugin id is read from
# manifest.json, so the destination folder always matches what Obsidian expects.
#
#   ./scripts/deploy-local.sh ~/vaults/work             # build + copy (ship-like)
#   ./scripts/deploy-local.sh ~/vaults/work --link      # build + symlink + .hotreload (dev loop)
#   ./scripts/deploy-local.sh ~/vaults/work --no-build  # deploy the current dist/ as-is
#
# Bun must be on PATH to build (falls back to ~/.bun/bin).

set -euo pipefail

# The plugin package root is this script's parent directory's parent.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
    echo "usage: deploy-local.sh <vault-path> [--link] [--no-build]" >&2
}

# --- parse args --------------------------------------------------------------
VAULT=""
LINK=0
BUILD=1
for arg in "$@"; do
    case "$arg" in
        --link)      LINK=1 ;;
        --no-build)  BUILD=0 ;;
        -h|--help)   usage; exit 0 ;;
        -*)          echo "deploy-local: unknown option: $arg" >&2; usage; exit 2 ;;
        *)
            if [ -n "$VAULT" ]; then
                echo "deploy-local: unexpected argument: $arg" >&2; usage; exit 2
            fi
            VAULT="$arg"
            ;;
    esac
done

[ -n "$VAULT" ] || { usage; exit 2; }

# --- validate the vault ------------------------------------------------------
[ -d "$VAULT" ] || { echo "deploy-local: not a directory: $VAULT" >&2; exit 1; }
VAULT="$(cd "$VAULT" && pwd)"  # normalise to an absolute path
if [ ! -d "$VAULT/.obsidian" ]; then
    echo "deploy-local: warning: $VAULT has no .obsidian/ — is it an Obsidian vault? (continuing)" >&2
fi

# --- plugin id from the manifest ---------------------------------------------
MANIFEST="$PKG_DIR/manifest.json"
[ -f "$MANIFEST" ] || { echo "deploy-local: missing $MANIFEST" >&2; exit 1; }
PLUGIN_ID="$(grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' "$MANIFEST" \
    | sed 's/.*"\([^"]*\)"$/\1/')"
[ -n "$PLUGIN_ID" ] || { echo "deploy-local: could not read \"id\" from $MANIFEST" >&2; exit 1; }

# --- build (unless --no-build) -----------------------------------------------
if [ "$BUILD" -eq 1 ]; then
    command -v bun >/dev/null 2>&1 || export PATH="$HOME/.bun/bin:$PATH"
    command -v bun >/dev/null 2>&1 || { echo "deploy-local: bun not found on PATH" >&2; exit 1; }
    echo "deploy-local: building…"
    ( cd "$PKG_DIR" && bun run build )
fi

DIST="$PKG_DIR/dist"
for f in main.js manifest.json styles.css; do
    [ -f "$DIST/$f" ] || {
        echo "deploy-local: missing $DIST/$f — build first, or drop --no-build" >&2
        exit 1
    }
done

# --- deploy ------------------------------------------------------------------
DEST="$VAULT/.obsidian/plugins/$PLUGIN_ID"
mkdir -p "$DEST"
for f in main.js manifest.json styles.css; do
    rm -f "$DEST/$f"
    if [ "$LINK" -eq 1 ]; then
        ln -s "$DIST/$f" "$DEST/$f"
    else
        cp "$DIST/$f" "$DEST/$f"
    fi
done
[ "$LINK" -eq 1 ] && touch "$DEST/.hotreload"  # opt this folder into the Hot-Reload plugin

MODE=$([ "$LINK" -eq 1 ] && echo symlinked || echo copied)
echo "deploy-local: $MODE \"$PLUGIN_ID\" -> $DEST"
echo
echo "Next:"
echo "  1. Obsidian → Settings → Community plugins → turn off Restricted mode → enable \"$PLUGIN_ID\"."
echo "  2. Reload after each redeploy: toggle the plugin off/on, or Ctrl/Cmd-P → \"Reload app without saving\"."
if [ "$LINK" -eq 1 ]; then
    echo "  3. (dev loop) With the Hot-Reload community plugin installed, the .hotreload marker makes it auto-reload on rebuild."
fi
