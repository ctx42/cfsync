// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

// Package version renders the cfsync build version. The metadata is injected at
// install time via -ldflags -X by cmd/install (see [LDFlags]); a binary built
// without the installer — a plain `go install` or `go build` — falls back to
// the metadata the Go toolchain embeds in [debug.BuildInfo].
package version

import (
	"runtime/debug"
	"strings"
	"time"

	"github.com/ctx42/ring/pkg/ring"
)

// importPath is the package path targeted by the -X linker definitions.
const importPath = "github.com/ctx42/cfsync/internal/version"

// Build metadata set by cmd/install via -ldflags -X. Empty in a binary built
// without the installer, when [Line] falls back to [debug.BuildInfo].
var (
	buildRev   string // Release version, e.g. "v1.2.3".
	buildHash  string // Short commit hash, e.g. "abc1234".
	buildDate  string // UTC RFC-3339 build timestamp.
	buildState string // Working-tree state at build: "clean" or "dirty".
)

// Line renders the one-line version string for the command named cmd, e.g.
// "cfsync v1.2.3, hash: abc1234, build date: 2026-07-09T12:00:00Z, scm state:
// clean". Injected ldflags values win; a field the injection left empty is
// taken from info, and one still unknown is omitted — except the version, which
// falls back to "dev". info is [debug.ReadBuildInfo]'s result, or nil. On the
// fallback path the "build date" field carries the commit time (vcs.time), not
// a true build time, since only the installer stamps the latter.
func Line(cmd string, info *debug.BuildInfo) string {
	rev, hash, date, state := resolve(info)

	var b strings.Builder
	b.WriteString(cmd)
	b.WriteByte(' ')
	b.WriteString(rev)
	writeField(&b, "hash", hash)
	writeField(&b, "build date", date)
	writeField(&b, "scm state", state)
	return b.String()
}

// LDFlags returns the -ldflags argument cmd/install passes to `go build` to
// embed the build metadata: one -X definition per known field. The version and
// SCM fields come from info (the installer's own build info); the build date is
// the current time from rng's clock. A field info does not carry is omitted.
func LDFlags(rng *ring.Ring, info *debug.BuildInfo) string {
	rev, hash, _, state := fromBuildInfo(info)
	date := rng.Clock()().UTC().Format(time.RFC3339)

	var defs []string
	defs = appendFlag(defs, "buildRev", rev)
	defs = appendFlag(defs, "buildHash", hash)
	defs = appendFlag(defs, "buildDate", date)
	defs = appendFlag(defs, "buildState", state)
	return strings.Join(defs, " ")
}

// resolve returns the four metadata fields for [Line]: the injected build
// variable when set, otherwise the value from info. The version defaults to
// "dev" when neither source carries it.
func resolve(info *debug.BuildInfo) (rev, hash, date, state string) {
	rev, hash, date, state = buildRev, buildHash, buildDate, buildState
	iRev, iHash, iDate, iState := fromBuildInfo(info)
	if rev == "" {
		rev = iRev
	}
	if hash == "" {
		hash = iHash
	}
	if date == "" {
		date = iDate
	}
	if state == "" {
		state = iState
	}
	if rev == "" {
		rev = "dev"
	}
	return rev, hash, date, state
}

// fromBuildInfo extracts the release version, short commit hash, commit time,
// and working-tree state from info, returning "" for any field info does not
// carry. The module version "(devel)", reported for a local build, counts as
// absent.
func fromBuildInfo(info *debug.BuildInfo) (rev, hash, date, state string) {
	if info == nil {
		return "", "", "", ""
	}
	if v := info.Main.Version; v != "" && v != "(devel)" {
		rev = v
	}
	for _, set := range info.Settings {
		switch set.Key {
		case "vcs.revision":
			hash = shortHash(set.Value)
		case "vcs.time":
			date = set.Value
		case "vcs.modified":
			state = vcsState(set.Value)
		}
	}
	return rev, hash, date, state
}

// shortHash truncates a commit hash to its first seven characters.
func shortHash(hash string) string {
	if len(hash) >= 7 {
		return hash[:7]
	}
	return hash
}

// vcsState maps the vcs.modified build setting to a working-tree state word.
func vcsState(modified string) string {
	switch modified {
	case "true":
		return "dirty"
	case "false":
		return "clean"
	default:
		return ""
	}
}

// writeField appends ", label: val" to b, or nothing when val is empty.
func writeField(b *strings.Builder, label, val string) {
	if val == "" {
		return
	}
	b.WriteString(", ")
	b.WriteString(label)
	b.WriteString(": ")
	b.WriteString(val)
}

// appendFlag appends a "-X importPath.field=value" definition when value is
// non-empty, otherwise returns defs unchanged.
func appendFlag(defs []string, field, value string) []string {
	if value == "" {
		return defs
	}
	return append(defs, "-X "+importPath+"."+field+"="+value)
}
