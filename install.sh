#!/usr/bin/env sh
# SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
# SPDX-License-Identifier: MIT
#
# install.sh — install the cfsync binary from source with the Go toolchain.
#
# One-liner (no checkout needed):
#
#     curl -fsSL https://raw.githubusercontent.com/ctx42/cfsync/master/install.sh | sh
#
# This is a thin wrapper around `go install`: it checks for a recent enough Go
# toolchain, then compiles and installs cfsync into `$(go env GOBIN)` (or
# `$(go env GOPATH)/bin`). The installed binary reports its version from the
# module it was built from, so `cfsync version` names the release you pulled.

set -eu

die() {
	printf 'install.sh: %s\n' "$1" >&2
	exit 1
}

command -v go >/dev/null 2>&1 || die "Go toolchain not found on PATH"

# Warn (do not fail) if the toolchain is older than the module's go directive;
# an older compiler will refuse the build with its own clearer message.
need="1.26"
have=$(go env GOVERSION 2>/dev/null | sed 's/^go//')
case "$have" in
"") ;;
*)
	lowest=$(printf '%s\n%s\n' "$need" "$have" | sort -t. -k1,1n -k2,2n | head -n1)
	[ "$lowest" = "$need" ] || printf 'install.sh: warning: Go %s found, %s+ recommended\n' "$have" "$need" >&2
	;;
esac

pkg="github.com/ctx42/cfsync/cmd/cfsync@latest"

printf 'Installing %s\n' "$pkg"
go install "$pkg" || die "go install failed"

# Resolve the install directory the same way `go install` did, to report the
# path and nudge the user if it is not reachable from PATH.
bindir=$(go env GOBIN)
[ -n "$bindir" ] || bindir=$(go env GOPATH)/bin

printf 'Installed: %s\n' "$bindir/cfsync"
case ":${PATH}:" in
*":$bindir:"*) ;;
*) printf 'install.sh: note: %s is not on your PATH; add it to run "cfsync".\n' "$bindir" >&2 ;;
esac
