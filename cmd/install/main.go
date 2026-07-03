// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Command install builds the cfsync binary with its version metadata embedded
// and installs it into GOBIN. Set GOBIN (or GOPATH) in the environment to
// control where the binary lands.
//
// A plain `go build`/`go install` of ./cmd/cfsync cannot stamp the release
// version into the binary; this installer does, by reading its own build info
// and passing it to the linker. Typical usage:
//
//	go run github.com/ctx42/cfsync/cmd/install@latest   # install a release
//	go run ./cmd/install                                # install from a checkout
package main

import (
	"context"
	"fmt"
	"os"
	"runtime/debug"

	"github.com/ctx42/ring/pkg/ring"

	"github.com/ctx42/cfsync/internal/install"
)

func main() {
	rng := ring.New()
	info, _ := debug.ReadBuildInfo()
	if err := install.Main(context.Background(), rng, info); err != nil {
		_, _ = fmt.Fprintln(rng.Stderr(), err)
		os.Exit(1)
	}
}
