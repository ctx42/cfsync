// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Package install builds the cfsync binary with its version metadata embedded
// and installs it into GOBIN. [Main] is the entry point used by cmd/install. It
// relies only on the Go toolchain and never shells out to a VCS such as git.
package install

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"

	"github.com/ctx42/ring/pkg/ring"

	"github.com/ctx42/cfsync/internal/version"
)

// binName is the installed binary name, without any platform extension.
const binName = "cfsync"

// Main builds the cfsync binary with its version metadata embedded (via
// [version.LDFlags]) and installs it into GOBIN. info is the build info of the
// install command itself: it carries the version to embed and selects the
// build source — the working tree for `go run ./cmd/install` (a "(devel)"
// version), the module cache for `go run ...@version`. Set GOBIN (or GOPATH) in
// the environment to control where the binary lands. ctx cancels long
// toolchain steps (`go build`, `go mod download`).
func Main(ctx context.Context, rng *ring.Ring, info *debug.BuildInfo) error {
	if info == nil {
		return errors.New("cfsync: build info unavailable")
	}
	dst, err := goBinPath(ctx, rng)
	if err != nil {
		return err
	}
	src, err := sourceDir(ctx, rng, info)
	if err != nil {
		return err
	}
	return installTo(ctx, rng, info, src, dst)
}

// installTo builds cfsync from src and installs it into dst. It is the internal
// indirection behind [Main], which resolves src and dst from the environment;
// tests pass both explicitly to avoid touching the real GOBIN.
func installTo(
	ctx context.Context,
	rng *ring.Ring,
	info *debug.BuildInfo,
	src, dst string,
) error {

	if err := os.MkdirAll(dst, 0o755); err != nil {
		return fmt.Errorf("cfsync: create %q: %w", dst, err)
	}
	out := filepath.Join(dst, binaryName())
	return build(ctx, rng, src, out, version.LDFlags(rng, info))
}

// build runs `go build` for ./cmd/cfsync in src, writing the binary to out and
// applying ldflags when non-empty. It builds rather than installs so a
// read-only GOROOT or a prior `go get` cannot turn the step into a no-op.
func build(
	ctx context.Context,
	env ring.Environ,
	src, out, ldflags string,
) error {

	args := []string{"build"}
	if strings.TrimSpace(ldflags) != "" {
		args = append(args, "-ldflags", ldflags)
	}
	args = append(args, "-o", out, "./cmd/cfsync")

	cmd := exec.CommandContext(ctx, "go", args...)
	cmd.Env = env.EnvAll()
	cmd.Dir = src
	if combined, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("cfsync: build: %w: %s",
			err,
			strings.TrimSpace(string(combined)))
	}
	return nil
}

// sourceDir resolves the directory to build from: the module root for a devel
// build (`go run ./cmd/install` from any package path), or the module-cache
// directory for a published one (`go run ...@version`).
func sourceDir(
	ctx context.Context,
	env ring.Environ,
	info *debug.BuildInfo,
) (string, error) {

	if v := info.Main.Version; v == "" || v == "(devel)" {
		return moduleRoot(ctx, env)
	}
	return moduleCacheDir(ctx, env, info.Main.Path+"@"+info.Main.Version)
}

// moduleRoot returns the main module's root directory via `go list -m`, so a
// devel install started from a subdirectory still finds ./cmd/cfsync.
func moduleRoot(ctx context.Context, env ring.Environ) (string, error) {
	cmd := exec.CommandContext(ctx, "go", "list", "-m", "-f", "{{.Dir}}")
	cmd.Env = env.EnvAll()
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("cfsync: module root: %w: %s",
			err,
			strings.TrimSpace(stderr.String()))
	}
	dir := strings.TrimSpace(string(out))
	if dir == "" {
		return "", errors.New("cfsync: module root: empty dir")
	}
	return dir, nil
}

// goBinPath resolves the install destination the way `go install` does: GOBIN
// when set, otherwise GOPATH/bin.
func goBinPath(ctx context.Context, env ring.Environ) (string, error) {
	gobin, err := goEnv(ctx, env, "GOBIN")
	if err != nil {
		return "", err
	}
	if gobin != "" {
		return gobin, nil
	}
	gopath, err := goEnv(ctx, env, "GOPATH")
	if err != nil {
		return "", err
	}
	if gopath == "" {
		return "", errors.New("cfsync: cannot resolve GOBIN or GOPATH")
	}
	// go install uses the first GOPATH entry when several are listed.
	paths := filepath.SplitList(gopath)
	if paths[0] == "" {
		return "", errors.New("cfsync: cannot resolve GOBIN or GOPATH")
	}
	return filepath.Join(paths[0], "bin"), nil
}

// goEnv returns the value of a single `go env` variable. On failure it includes
// the command's stderr, which cmd.Output would otherwise strand in ExitError.
func goEnv(ctx context.Context, env ring.Environ, key string) (string, error) {
	cmd := exec.CommandContext(ctx, "go", "env", key)
	cmd.Env = env.EnvAll()
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("cfsync: go env %s: %w: %s",
			key,
			err,
			strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(string(out)), nil
}

// moduleCacheDir runs `go mod download -json <module>` and returns the local
// cache directory for that module. `go mod download -json` reports a
// module-level failure in the JSON Error field, so that is surfaced before the
// process error, whose stderr is otherwise stranded in ExitError by cmd.Output.
func moduleCacheDir(
	ctx context.Context,
	env ring.Environ,
	module string,
) (string, error) {

	cmd := exec.CommandContext(ctx, "go", "mod", "download", "-json", module)
	cmd.Env = env.EnvAll()
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()

	var dl struct {
		Dir   string `json:"Dir"`
		Error string `json:"Error"`
	}
	perr := json.Unmarshal(out, &dl)
	switch {

	case perr == nil && dl.Error != "":
		return "", fmt.Errorf("cfsync: module download %s: %s", module, dl.Error)

	case err != nil:
		return "", fmt.Errorf("cfsync: module download %s: %w: %s",
			module,
			err,
			strings.TrimSpace(stderr.String()))

	case perr != nil:
		return "", fmt.Errorf("cfsync: go mod download parse: %w", perr)

	case dl.Dir == "":
		return "", fmt.Errorf("cfsync: module download %s: empty dir", module)
	}
	return dl.Dir, nil
}

// binaryName is the installed file name for the current platform.
func binaryName() string {
	if runtime.GOOS == "windows" {
		return binName + ".exe"
	}
	return binName
}
