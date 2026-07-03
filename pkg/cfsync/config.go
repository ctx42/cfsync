// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ctx42/ring/pkg/ring"
	"github.com/goccy/go-yaml"
)

// configFile is the configuration file read when --config is absent.
const configFile = ".cfsync.yaml"

// envFile is the dotenv file read when --env is absent.
const envFile = ".env"

// defaultTimeout bounds a single HTTP request to the Site when the
// configuration does not set a timeout.
const defaultTimeout = 30 * time.Second

// Environment variables that override the matching configuration fields.
const (
	envHost    = "CFSYNC_HOST"
	envAccount = "CFSYNC_ACCOUNT"
	envToken   = "CFSYNC_TOKEN" //nolint:gosec // Env var name, not a secret.
	envWorkDir = "CFSYNC_WORK_DIR"
)

// config holds the settings cfsync needs to reach an Atlassian Site.
type config struct {
	// Host, Account, and Token are the Site credentials. They are never read
	// from the configuration file; loadConfig fills them from the environment
	// (see [config.override]) and rejects a file that sets them.
	Host    string `yaml:"-"`
	Account string `yaml:"-"`
	Token   string `yaml:"-"`

	// Timeout bounds a single HTTP request to the Site, given as a duration
	// string such as "30s" or "1m30s". A zero or unset value selects
	// defaultTimeout.
	Timeout time.Duration `yaml:"timeout"`

	// WorkDir is the directory the downloaded Confluence pages are written to.
	// Like the credentials it comes from the environment (CFSYNC_WORK_DIR) or
	// the --work-dir flag, never the configuration file. A relative value
	// anchors to the directory of the configuration file; loadConfig rewrites
	// it to an absolute, cleaned path.
	WorkDir string `yaml:"-"`

	// Pages maps a destination file to the Confluence page or folder to
	// download into it. In the file the key is a path relative to WorkDir
	// ending in ".md"; loadConfig rewrites each key to its absolute,
	// cleaned path under WorkDir.
	Pages map[string]string `yaml:"pages"`

	// Folders maps a destination directory to the Confluence folder to sync
	// into it. In the file the key is a directory path relative to WorkDir;
	// loadConfig rewrites each key to its absolute, cleaned path under
	// WorkDir. The folder's pages and sub-folders are mirrored directly under
	// the key.
	Folders map[string]string `yaml:"folders"`

	// Spaces maps a destination directory to the Confluence space to mirror
	// into it. In the file the key is a directory path relative to WorkDir and
	// the value is a link to the space root, such as "/wiki/spaces/TEST";
	// loadConfig rewrites each key to its absolute, cleaned path under WorkDir.
	// The space's whole page-and-folder tree is mirrored under the key. Spaces
	// may be combined with Pages and Folders; no page may be claimed by more
	// than one entry (see [config.collides]).
	Spaces map[string]string `yaml:"spaces"`

	// links is the link index for this run, used to rewrite cross-page links
	// between their Confluence and local Markdown forms. It is not read from the
	// configuration file: pull builds it and push loads it, each once per
	// process on a freshly loaded config, so it never carries state between
	// runs. A nil value disables link rewriting.
	links *linkIndex

	// report receives progress events during a long-running pull or push. It is
	// not read from the configuration file: pull and push set it for the run. A
	// nil value is treated as [noopReporter]; see [config.reporter].
	report reporter
}

// reporter returns the progress reporter set for this run, or a [noopReporter]
// when none was set, so callers never guard against a nil report.
func (cfg *config) reporter() reporter {
	if cfg.report == nil {
		return noopReporter{}
	}
	return cfg.report
}

// stdoutText returns the text a completed pull or push writes to stdout: the
// summary alone when the reporter already streamed the per-page log itself,
// otherwise the buffered pageLog followed by the summary.
func (cfg *config) stdoutText(pageLog, summary string) string {
	if cfg.reporter().streamsLog() {
		return summary
	}
	return pageLog + summary
}

// domain returns the Site host without its scheme, such as
// "example.atlassian.net" for a Host of "https://example.atlassian.net". It is
// stamped into every pulled page as the cf_domain frontmatter field.
func (cfg *config) domain() string {
	if u, err := url.Parse(cfg.Host); err == nil && u.Host != "" {
		return u.Host
	}
	host := strings.TrimPrefix(cfg.Host, "https://")
	return strings.TrimPrefix(host, "http://")
}

// loadConfig reads the configuration file at the path, applies environment
// overrides from rng, and validates the result. An empty path selects
// [configFile].
func loadConfig(rng *ring.Ring, path string) (*config, error) {
	if path == "" {
		path = configFile
	}

	data, err := os.ReadFile(path) //nolint:gosec // path is user-supplied.
	if err != nil {
		return nil, fmt.Errorf("reading config: %w", err)
	}
	if err = rejectEnvKeys(data); err != nil {
		return nil, err
	}

	var cfg config
	if err = yaml.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parsing config: %w", err)
	}

	cfg.override(rng)
	if err = cfg.validate(); err != nil {
		return nil, err
	}
	if err = cfg.resolve(filepath.Dir(path)); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// rejectEnvKeys returns an error when the YAML in data sets a key that cfsync
// reads only from the environment or the --work-dir flag: host, account,
// token, or work_dir. It keeps the credentials and work directory out of the
// configuration file. A malformed file yields no error here; loadConfig's own
// parse reports it.
func rejectEnvKeys(data []byte) error {
	var raw map[string]any
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil
	}
	for _, key := range []string{"host", "account", "token", "work_dir"} {
		if _, ok := raw[key]; ok {
			return fmt.Errorf("config: %q must not be set in the config file", key)
		}
	}
	return nil
}

// loadEnvFile reads KEY=VALUE lines from the dotenv file at path into rng,
// setting only variables rng does not already have a non-empty value for, so an
// environment value always wins over the file. An empty path selects [envFile].
// A missing file is an error only when explicit is true; otherwise it is
// ignored, so the credentials may instead come from the process environment.
// Blank lines and lines beginning with '#' are skipped, the value is split on
// the first '=', and surrounding quotes on it are stripped.
func loadEnvFile(rng *ring.Ring, path string, explicit bool) error {
	if path == "" {
		path = envFile
	}

	f, err := os.Open(path) //nolint:gosec // path is user-supplied.
	if err != nil {
		if !explicit && errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return fmt.Errorf("reading env file: %w", err)
	}
	defer func() { _ = f.Close() }()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		val = strings.Trim(strings.TrimSpace(val), `"'`)
		if key == "" || rng.EnvGet(key) != "" {
			continue
		}
		rng.EnvSet(key, val)
	}
	if err = sc.Err(); err != nil {
		return fmt.Errorf("reading env file: %w", err)
	}
	return nil
}

// reqTimeout returns the per-request HTTP timeout: the configured value, or
// defaultTimeout when it is unset or non-positive.
func (cfg *config) reqTimeout() time.Duration {
	if cfg.Timeout <= 0 {
		return defaultTimeout
	}
	return cfg.Timeout
}

// withReqTimeout returns ctx cancelled after the configured per-request HTTP
// timeout. Use it around a single HTTP call so multi-request page work is not
// bound by one shared deadline.
func (cfg *config) withReqTimeout(
	ctx context.Context,
) (context.Context, context.CancelFunc) {

	return context.WithTimeout(ctx, cfg.reqTimeout())
}

// override replaces configuration fields with the matching environment
// variables read from rng, for each variable set to a non-empty value.
func (cfg *config) override(rng *ring.Ring) {
	if v := rng.EnvGet(envHost); v != "" {
		cfg.Host = v
	}
	if v := rng.EnvGet(envAccount); v != "" {
		cfg.Account = v
	}
	if v := rng.EnvGet(envToken); v != "" {
		cfg.Token = v
	}
	if v := rng.EnvGet(envWorkDir); v != "" {
		cfg.WorkDir = v
	}
}

// validate reports whether the configuration is usable, returning an error
// that names the first problem found.
func (cfg *config) validate() error {
	switch {
	case cfg.Host == "":
		return errors.New("config: host is required")
	case cfg.Account == "":
		return errors.New("config: account is required")
	case cfg.Token == "":
		return errors.New("config: token is required")
	case cfg.WorkDir == "":
		return errors.New("config: work_dir is required")
	}

	u, err := url.Parse(cfg.Host)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return fmt.Errorf("config: host %q must be an https URL", cfg.Host)
	}
	return nil
}

// resolve rewrites WorkDir, the Pages keys, and the Folders keys to absolute,
// cleaned paths and validates each entry. A relative WorkDir, or a relative
// dir, anchors to dir, which is the directory of the configuration file. It
// returns an error naming the first invalid entry found. WorkDir must be
// non-empty; call validate first.
func (cfg *config) resolve(dir string) error {
	if !filepath.IsAbs(cfg.WorkDir) {
		cfg.WorkDir = filepath.Join(dir, cfg.WorkDir)
	}
	abs, err := filepath.Abs(cfg.WorkDir)
	if err != nil {
		return fmt.Errorf("config: resolving work_dir: %w", err)
	}
	cfg.WorkDir = abs

	if err = cfg.resolvePages(); err != nil {
		return err
	}
	// Folders and spaces share destination roots: the same absolute path
	// must not be claimed by both (or twice within one map).
	roots := make(map[string]string)
	if err = cfg.resolveFolders(roots); err != nil {
		return err
	}
	return cfg.resolveSpaces(roots)
}

// resolvePages rewrites each Pages key to its absolute, cleaned path under
// WorkDir and validates each entry, returning an error naming the first
// invalid entry found. WorkDir must already be absolute.
func (cfg *config) resolvePages() error {
	if len(cfg.Pages) == 0 {
		return nil
	}

	resolved := make(map[string]string, len(cfg.Pages))
	seen := make(map[string]string, len(cfg.Pages))
	seenID := make(map[string]string, len(cfg.Pages))
	for dest, src := range cfg.Pages {
		if err := validateDest(dest); err != nil {
			return err
		}
		if src == "" {
			return fmt.Errorf("config: page %q has an empty source", dest)
		}
		path := filepath.Join(cfg.WorkDir, dest)
		if prev, ok := seen[path]; ok {
			return fmt.Errorf(
				"config: pages %q and %q resolve to the same destination",
				prev, dest,
			)
		}
		// A single-page pull resolves a page id from the config alone, without
		// the discovery that lets collides reject a duplicate id across sources.
		// Reject a duplicate id among pages here so that resolution is
		// unambiguous. A non-page source (a folder) has no id to compare.
		if id, err := pageID(src); err == nil {
			if prev, ok := seenID[id]; ok {
				return fmt.Errorf(
					"config: pages %q and %q refer to the same page id %s",
					prev, dest, id,
				)
			}
			seenID[id] = dest
		}
		seen[path] = dest
		resolved[path] = src
	}
	cfg.Pages = resolved
	return nil
}

// resolveFolders rewrites each Folders key to its absolute, cleaned path under
// WorkDir and validates each entry, returning an error naming the first
// invalid entry found. roots records claimed root destinations (folder or
// space) so a later space cannot reuse the same path. WorkDir must already be
// absolute.
func (cfg *config) resolveFolders(roots map[string]string) error {
	if len(cfg.Folders) == 0 {
		return nil
	}

	resolved := make(map[string]string, len(cfg.Folders))
	for root, src := range cfg.Folders {
		if err := validateRoot(root); err != nil {
			return err
		}
		if src == "" {
			return fmt.Errorf("config: folder %q has an empty source", root)
		}
		if _, err := folderID(src); err != nil {
			return fmt.Errorf("config: folder %q: %w", root, err)
		}
		path := filepath.Join(cfg.WorkDir, root)
		if prev, ok := roots[path]; ok {
			return fmt.Errorf(
				"config: %s and folder %q resolve to the same destination",
				prev, root,
			)
		}
		roots[path] = fmt.Sprintf("folder %q", root)
		resolved[path] = src
	}
	cfg.Folders = resolved
	return nil
}

// resolveSpaces rewrites each Spaces key to its absolute, cleaned path under
// WorkDir and validates each entry, returning an error naming the first
// invalid entry found. roots is the shared folder/space destination map from
// [config.resolveFolders]. WorkDir must already be absolute.
func (cfg *config) resolveSpaces(roots map[string]string) error {
	if len(cfg.Spaces) == 0 {
		return nil
	}

	resolved := make(map[string]string, len(cfg.Spaces))
	for root, src := range cfg.Spaces {
		if err := validateRoot(root); err != nil {
			return err
		}
		if src == "" {
			return fmt.Errorf("config: space %q has an empty source", root)
		}
		if _, err := spaceLinkKey(src); err != nil {
			return fmt.Errorf("config: space %q: %w", root, err)
		}
		path := filepath.Join(cfg.WorkDir, root)
		if prev, ok := roots[path]; ok {
			return fmt.Errorf(
				"config: %s and space %q resolve to the same destination",
				prev, root,
			)
		}
		roots[path] = fmt.Sprintf("space %q", root)
		resolved[path] = src
	}
	cfg.Spaces = resolved
	return nil
}

// validateDest reports whether dest is a valid page destination: a non-empty,
// relative path ending in ".md" that does not escape the work directory.
func validateDest(dest string) error {
	switch {
	case dest == "":
		return errors.New("config: page destination is empty")
	case filepath.IsAbs(dest):
		return fmt.Errorf("config: page destination %q must be relative", dest)
	case filepath.Ext(dest) != ".md":
		return fmt.Errorf("config: page destination %q must end in .md", dest)
	}

	clean := filepath.Clean(dest)
	up := ".." + string(filepath.Separator)
	if clean == ".." || strings.HasPrefix(clean, up) {
		return fmt.Errorf("config: page destination %q escapes work_dir", dest)
	}
	return nil
}

// validateRoot reports whether root is a valid folder or space destination: a
// non-empty, relative directory path that does not end in ".md" and does not
// escape the work directory.
func validateRoot(root string) error {
	switch {
	case root == "":
		return errors.New("config: root destination is empty")
	case filepath.IsAbs(root):
		return fmt.Errorf("config: root destination %q must be relative", root)
	case filepath.Ext(root) == ".md":
		return fmt.Errorf("config: root destination %q must not end in .md", root)
	}

	clean := filepath.Clean(root)
	up := ".." + string(filepath.Separator)
	if clean == ".." || strings.HasPrefix(clean, up) {
		return fmt.Errorf("config: root destination %q escapes work_dir", root)
	}
	return nil
}
