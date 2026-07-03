// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Package cfsync implements the cfsync command-line interface: command
// dispatch, flag parsing, configuration loading, and the Confluence connection
// test.
package cfsync

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"path/filepath"
	"runtime/debug"

	"github.com/ctx42/ring/pkg/ring"
	"github.com/ctx42/xflag/pkg/xflag"

	"github.com/ctx42/cfsync/internal/version"
)

// Process exit codes returned by [Main].
const (
	exitOK     = 0   // Success.
	exitErr    = 1   // Failure of any kind.
	exitCancel = 130 // Interrupted by the user (128 + SIGINT).
)

// Main runs the cfsync command and returns the process exit code. It reads the
// command name and its flags from the arguments of rng, along with environment
// variables and standard streams, and honors cancellation of ctx.
func Main(ctx context.Context, rng *ring.Ring) int {
	args := rng.Args()
	if len(args) == 0 {
		writeUsage(rng.Stderr())
		return exitErr
	}

	cmd, rest := args[0], args[1:]
	switch cmd {
	case "version":
		info, _ := debug.ReadBuildInfo()
		_, _ = fmt.Fprintf(rng.Stdout(), "%s\n", version.Line("cfsync", info))
		return exitOK

	case "help":
		return runHelp(rng, rest)

	case "test":
		return runTest(ctx, rng, rest)

	case "pull":
		return runPull(ctx, rng, rest)

	case "push":
		return runPush(ctx, rng, rest)

	case "gc":
		return runGC(ctx, rng, rest)

	case "clean":
		return runClean(ctx, rng, rest)

	default:
		_, _ = fmt.Fprintf(rng.Stderr(), "cfsync: unknown command: %s\n", cmd)
		_, _ = fmt.Fprint(rng.Stderr(), `Run "cfsync help" for usage.`+"\n")
		return exitErr
	}
}

// runTest parses the test command flags and verifies authenticated access to
// the Atlassian Site.
func runTest(ctx context.Context, rng *ring.Ring, args []string) int {
	fst := newFlagSet(rng, "test")
	cfl := addConfigFlags(fst, false)
	if code, ok := parseCmd(rng, fst, testUsage, args); !ok {
		return code
	}
	if err := cfl.setup(rng); err != nil {
		return report(rng, "", err)
	}
	out, err := checkConn(ctx, rng, *cfl.config)
	return report(rng, out, err)
}

// runPull parses the pull command flags and pulls pages into the ADF cache.
func runPull(ctx context.Context, rng *ring.Ring, args []string) int {
	fst := newFlagSet(rng, "pull")
	cfl := addConfigFlags(fst, true)
	if code, ok := parseCmd(rng, fst, pullUsage, args); !ok {
		return code
	}
	selected, err := selectedPage("pull", fst.Args())
	if err != nil {
		return report(rng, "", err)
	}
	if err = cfl.setup(rng); err != nil {
		return report(rng, "", err)
	}
	out, err := pull(ctx, rng, *cfl.config, selected)
	return report(rng, out, err)
}

// runPush parses the push command flags and pushes edited Markdown back to
// Confluence.
func runPush(ctx context.Context, rng *ring.Ring, args []string) int {
	fst := newFlagSet(rng, "push")
	cfl := addConfigFlags(fst, true)
	yes := fst.Bool("yes", false, yesUsage)
	if code, ok := parseCmd(rng, fst, pushUsage, args); !ok {
		return code
	}
	selected, err := selectedPage("push", fst.Args())
	if err != nil {
		return report(rng, "", err)
	}
	if err = cfl.setup(rng); err != nil {
		return report(rng, "", err)
	}
	out, err := push(ctx, rng, *cfl.config, selected, *yes)
	return report(rng, out, err)
}

// runGC parses the gc command flags and reports orphaned files in the shared
// assets directory, deleting them when --prune is set.
func runGC(ctx context.Context, rng *ring.Ring, args []string) int {
	fst := newFlagSet(rng, "gc")
	cfl := addConfigFlags(fst, true)
	prune := fst.Bool("prune", false, "delete the orphaned files")
	if code, ok := parseCmd(rng, fst, gcUsage, args); !ok {
		return code
	}
	if err := cfl.setup(rng); err != nil {
		return report(rng, "", err)
	}
	out, err := gc(ctx, rng, *cfl.config, *prune)
	return report(rng, out, err)
}

// runClean parses the clean command flags and removes local files no longer in
// Confluence.
func runClean(ctx context.Context, rng *ring.Ring, args []string) int {
	fst := newFlagSet(rng, "clean")
	cfl := addConfigFlags(fst, true)
	yes := fst.Bool("yes", false, yesUsage)
	if code, ok := parseCmd(rng, fst, cleanUsage, args); !ok {
		return code
	}
	if err := cfl.setup(rng); err != nil {
		return report(rng, "", err)
	}
	out, err := clean(ctx, rng, *cfl.config, *yes)
	return report(rng, out, err)
}

// runHelp prints the top-level usage, or the usage of the command named in
// args, to stdout. Naming an unknown command is an error reported to stderr.
func runHelp(rng *ring.Ring, args []string) int {
	if len(args) == 0 {
		writeUsage(rng.Stdout())
		return exitOK
	}
	usage, ok := commandUsage(args[0])
	if !ok {
		format := "cfsync: unknown command: %s\n"
		_, _ = fmt.Fprintf(rng.Stderr(), format, args[0])
		return exitErr
	}
	_, _ = fmt.Fprint(rng.Stdout(), usage)
	return exitOK
}

// newFlagSet returns a flag set for command cmd that reports parse errors to
// rng's stderr and prints no usage of its own, leaving the caller to route
// help and errors. The name is "cfsync <cmd>" so error messages self-identify.
func newFlagSet(rng *ring.Ring, cmd string) *xflag.FlagSet {
	fst := xflag.NewFlagSet("cfsync "+cmd, flag.ContinueOnError)
	fst.SetOutput(rng.Stderr())
	fst.Usage = func() {}
	return fst
}

// configFlags holds the flags common to the config-reading commands and the
// pointers backing them. A nil workDir means the command does not offer
// --work-dir.
type configFlags struct {
	config  *string
	env     *string
	workDir *string
}

// addConfigFlags registers --config and --env on fst, and --work-dir when
// withWorkDir is set, returning the pointers backing them.
func addConfigFlags(fst *xflag.FlagSet, withWorkDir bool) *configFlags {
	cfl := &configFlags{
		config: fst.String("config", "", "path to the configuration file"),
		env:    fst.String("env", "", "path to the .env file (default ./.env)"),
	}
	if withWorkDir {
		cfl.workDir = fst.String("work-dir", "", wdUsage)
	}
	return cfl
}

// setup applies the --work-dir override to rng's environment and loads the
// .env file, so both reach loadConfig through rng.
func (cfl *configFlags) setup(rng *ring.Ring) error {
	if cfl.workDir != nil && *cfl.workDir != "" {
		rng.EnvSet(envWorkDir, *cfl.workDir)
	}
	envToLoad, envExplicit := envFilePath(*cfl.config, *cfl.env)
	return loadEnvFile(rng, envToLoad, envExplicit)
}

// parseCmd parses args into fst for the command whose help text is usage. On
// -h/--help it prints usage to stdout and returns (exitOK, false); on a parse
// error it returns (exitErr, false) with the message already on stderr;
// otherwise it returns (0, true) for the caller to continue.
func parseCmd(
	rng *ring.Ring,
	fst *xflag.FlagSet,
	usage string,
	args []string,
) (int, bool) {

	err := fst.Parse(args)
	if err == nil {
		return 0, true
	}
	if errors.Is(err, flag.ErrHelp) {
		_, _ = fmt.Fprint(rng.Stdout(), usage)
		return exitOK, false
	}
	return exitErr, false
}

// envFilePath returns the dotenv path to load and whether it was requested
// explicitly. A non-empty envPath (the --env flag) is used as given and is
// explicit, so a missing file is an error. Otherwise the default .env is taken
// from the directory of the config file — where configPath is empty it is
// [configFile] — so it sits beside the config the way work_dir and page paths
// resolve against it, rather than against the current directory; that default
// is not explicit, so a missing file is ignored.
func envFilePath(configPath, envPath string) (string, bool) {
	if envPath != "" {
		return envPath, true
	}
	if configPath == "" {
		configPath = configFile
	}
	return filepath.Join(filepath.Dir(configPath), envFile), false
}

// selectedPage returns the single optional page argument for cmd, or an error
// naming cmd when more than one positional argument is given. An absent
// argument yields "", meaning the command acts on every configured page.
func selectedPage(cmd string, args []string) (string, error) {
	if len(args) > 1 {
		return "", fmt.Errorf("%s accepts at most one page", cmd)
	}
	if len(args) == 1 {
		return args[0], nil
	}
	return "", nil
}

// report is the command output sink: it writes out to stdout and err to
// stderr, and returns the process exit code. It is the single place where
// cfsync decides where a command's result and errors go; command functions
// return them rather than printing. A [context.Canceled] error means the user
// interrupted the run: out already carries the "canceled" summary, so report
// writes it and returns [exitCancel] without an error line. Otherwise it
// returns [exitErr] when err is non-nil, else [exitOK].
func report(rng *ring.Ring, out string, err error) int {
	if out != "" {
		_, _ = fmt.Fprint(rng.Stdout(), out)
	}
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return exitCancel
		}
		_, _ = fmt.Fprintf(rng.Stderr(), "cfsync: %s\n", err)
		return exitErr
	}
	return exitOK
}

// writeUsage prints the top-level cfsync usage information to w.
func writeUsage(w io.Writer) {
	const usage = "" +
		"cfsync — sync Confluence content to local Markdown files.\n" +
		"\n" +
		"Usage:\n" +
		"  cfsync <command> [flags] [page]\n" +
		"\n" +
		"Commands:\n" +
		"  test      Verify authenticated access to the Atlassian Site.\n" +
		"  pull      Pull configured pages, folders, and spaces into\n" +
		"            the ADF cache.\n" +
		"  push      Push edited Markdown back to Confluence.\n" +
		"  gc        List orphaned files in the shared _assets directory.\n" +
		"  clean     Remove local files no longer in Confluence.\n" +
		"  version   Print the program version.\n" +
		"  help      Print this help, or help for a command.\n" +
		"\n" +
		"Run \"cfsync help <command>\" for a command's details and flags.\n"
	_, _ = fmt.Fprint(w, usage)
}

// commandUsage returns the usage text for command cmd and whether cmd is a
// known command with dedicated help.
func commandUsage(cmd string) (string, bool) {
	switch cmd {
	case "test":
		return testUsage, true
	case "pull":
		return pullUsage, true
	case "push":
		return pushUsage, true
	case "gc":
		return gcUsage, true
	case "clean":
		return cleanUsage, true
	default:
		return "", false
	}
}

// Flag description strings shared across the commands that register them.
const (
	// wdUsage describes the --work-dir flag.
	wdUsage = "directory to write pages to (overrides CFSYNC_WORK_DIR)"

	// yesUsage describes the --yes flag.
	yesUsage = "skip confirmation prompts"
)

// Per-command usage text, printed by "cfsync help <cmd>" and by a command's
// own -h/--help flag.
const (
	// flagsConfigEnv lists the --config and --env flag help lines shared by
	// every config-reading command.
	flagsConfigEnv = "" +
		"  --config <path>   Configuration file path (default ./.cfsync.yaml).\n" +
		"  --env <path>      Path to the .env file (default ./.env).\n"

	// flagsCommon extends flagsConfigEnv with --work-dir for the commands that
	// write pages.
	flagsCommon = flagsConfigEnv +
		"  --work-dir <path> Directory pages are written to; overrides\n" +
		"                    CFSYNC_WORK_DIR. Required unless that is set.\n"

	// testUsage is the help text for the test command.
	testUsage = "" +
		"cfsync test — verify authenticated access to the Atlassian Site.\n" +
		"\n" +
		"Usage:\n" +
		"  cfsync test [flags]\n" +
		"\n" +
		"Flags:\n" +
		flagsConfigEnv

	// pullUsage is the help text for the pull command.
	pullUsage = "" +
		"cfsync pull — pull pages into the ADF cache.\n" +
		"\n" +
		"Usage:\n" +
		"  cfsync pull [flags] [page]\n" +
		"\n" +
		"Pull configured pages, and the pages of configured folders and\n" +
		"spaces, into the ADF cache. With a [page] argument — a\n" +
		"work-dir-relative or absolute path to one managed .md file — pull\n" +
		"only that page; a Confluence link or id is not accepted.\n" +
		"\n" +
		"Flags:\n" +
		flagsCommon

	// pushUsage is the help text for the push command.
	pushUsage = "" +
		"cfsync push — push edited Markdown back to Confluence.\n" +
		"\n" +
		"Usage:\n" +
		"  cfsync push [flags] [page]\n" +
		"\n" +
		"Push edited Markdown back to Confluence. With a [page] argument — a\n" +
		"work-dir-relative or absolute path to one managed .md file — push\n" +
		"only that page; without it, push every edited page. A new .md file\n" +
		"under a space root (title and space_id but no page_id) is created\n" +
		"after you confirm it, restricted to you; add --yes to skip the\n" +
		"prompt.\n" +
		"\n" +
		"Flags:\n" +
		flagsCommon +
		"  --yes             Create new pages without asking.\n"

	// gcUsage is the help text for the gc command.
	gcUsage = "" +
		"cfsync gc — list orphaned files in the shared _assets directory.\n" +
		"\n" +
		"Usage:\n" +
		"  cfsync gc [flags]\n" +
		"\n" +
		"List orphaned files in the shared _assets directory (those no page\n" +
		"references). Add --prune to delete them.\n" +
		"\n" +
		"Flags:\n" +
		flagsCommon +
		"  --prune           Delete the orphaned asset files.\n"

	// cleanUsage is the help text for the clean command.
	cleanUsage = "" +
		"cfsync clean — remove local files no longer in Confluence.\n" +
		"\n" +
		"Usage:\n" +
		"  cfsync clean [flags]\n" +
		"\n" +
		"Remove local files under configured folder and space roots that no\n" +
		"longer exist in Confluence. Prompts for confirmation; add --yes to\n" +
		"delete without asking.\n" +
		"\n" +
		"Flags:\n" +
		flagsCommon +
		"  --yes             Delete without asking.\n"
)
