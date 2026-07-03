// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Command cfsync synchronizes Atlassian Confluence pages with local Markdown
// files.
//
// It loads a YAML configuration file with environment overrides, then runs the
// requested command: test verifies authenticated connectivity, pull and push
// sync configured pages and folders, gc reports or prunes orphaned assets, and
// clean removes local files deleted upstream.
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/ctx42/ring/pkg/ring"

	"github.com/ctx42/cfsync/pkg/cfsync"
)

func main() {
	ctx, stop := signal.NotifyContext(
		context.Background(), os.Interrupt, syscall.SIGTERM)
	code := cfsync.Main(ctx, ring.New())
	stop() // Restore default signal handling before os.Exit skips the defer.
	os.Exit(code)
}
