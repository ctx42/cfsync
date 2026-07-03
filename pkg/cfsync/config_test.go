// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/ctx42/ring/pkg/ring"
	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testkit/pkg/oskit"
)

func Test_loadConfig(t *testing.T) {
	t.Run("loads pages from the file and secrets from the env", func(t *testing.T) {
		// --- Given ---
		rng := ring.New(ring.WithEnv(secretEnv()))
		dir := t.TempDir()
		content := "" +
			"pages:\n" +
			"  a/b.md: /wiki/spaces/TEST/pages/1/Page\n" +
			"  c.md: /wiki/spaces/DOCS/folder/\n"
		path := oskit.Create(t, content, dir, configFile)

		// --- When ---
		have, err := loadConfig(rng, path)

		// --- Then ---
		assert.NoError(t, err)
		want := &config{
			Host:    "https://ex.atlassian.net",
			Account: "a@ex.com",
			Token:   "secret",
			WorkDir: filepath.Join(dir, "wd"),
			Pages: map[string]string{
				filepath.Join(dir, "wd", "a/b.md"): "/wiki/spaces/TEST/pages/1/Page",
				filepath.Join(dir, "wd", "c.md"):   "/wiki/spaces/DOCS/folder/",
			},
		}
		assert.Equal(t, want, have)
	})

	t.Run("loads folders from the file", func(t *testing.T) {
		// --- Given ---
		rng := ring.New(ring.WithEnv(secretEnv()))
		dir := t.TempDir()
		content := "folders:\n  docs: /wiki/spaces/DOCS/folder/100\n"
		path := oskit.Create(t, content, dir, configFile)

		// --- When ---
		have, err := loadConfig(rng, path)

		// --- Then ---
		assert.NoError(t, err)
		want := map[string]string{
			filepath.Join(dir, "wd", "docs"): "/wiki/spaces/DOCS/folder/100",
		}
		assert.Equal(t, want, have.Folders)
	})

	t.Run("loads spaces from the file", func(t *testing.T) {
		// --- Given ---
		rng := ring.New(ring.WithEnv(secretEnv()))
		dir := t.TempDir()
		content := "spaces:\n  team: /wiki/spaces/TEST\n"
		path := oskit.Create(t, content, dir, configFile)

		// --- When ---
		have, err := loadConfig(rng, path)

		// --- Then ---
		assert.NoError(t, err)
		want := map[string]string{
			filepath.Join(dir, "wd", "team"): "/wiki/spaces/TEST",
		}
		assert.Equal(t, want, have.Spaces)
	})

	t.Run("reads the default path when path is empty", func(t *testing.T) {
		// --- Given ---
		rng := ring.New(ring.WithEnv(secretEnv()))
		dir := t.TempDir()
		oskit.Create(t, "", dir, configFile)
		t.Chdir(dir)

		// --- When ---
		have, err := loadConfig(rng, "")

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "https://ex.atlassian.net", have.Host)
		assert.Equal(t, filepath.Join(dir, "wd"), have.WorkDir)
	})

	t.Run("error - config file sets an env key", func(t *testing.T) {
		// --- Given ---
		rng := ring.New(ring.WithEnv(secretEnv()))
		content := "token: leaked\n"
		path := oskit.Create(t, content, t.TempDir(), configFile)

		// --- When ---
		have, err := loadConfig(rng, path)

		// --- Then ---
		assert.Nil(t, have)
		assert.ErrorContain(t, `"token" must not be set in the config file`, err)
	})

	t.Run("error - file does not exist", func(t *testing.T) {
		// --- Given ---
		rng := ring.New()
		path := filepath.Join(t.TempDir(), "missing.yaml")

		// --- When ---
		have, err := loadConfig(rng, path)

		// --- Then ---
		assert.Nil(t, have)
		assert.ErrorContain(t, "reading config", err)
	})

	t.Run("error - content is not valid YAML", func(t *testing.T) {
		// --- Given ---
		rng := ring.New()
		content := "timeout: : : bad\n\t- nope\n"
		path := oskit.Create(t, content, t.TempDir(), configFile)

		// --- When ---
		have, err := loadConfig(rng, path)

		// --- Then ---
		assert.Nil(t, have)
		assert.ErrorRegexp(t, "parsing config.*cannot start any token", err)
	})

	t.Run("error - configuration is invalid", func(t *testing.T) {
		// --- Given --- an environment missing the host.
		env := []string{
			"CFSYNC_ACCOUNT=a@ex.com",
			"CFSYNC_TOKEN=secret",
			"CFSYNC_WORK_DIR=wd",
		}
		rng := ring.New(ring.WithEnv(env))
		path := oskit.Create(t, "", t.TempDir(), configFile)

		// --- When ---
		have, err := loadConfig(rng, path)

		// --- Then ---
		assert.Nil(t, have)
		assert.ErrorContain(t, "host is required", err)
	})

	t.Run("error - a page entry is invalid", func(t *testing.T) {
		// --- Given ---
		rng := ring.New(ring.WithEnv(secretEnv()))
		content := "pages:\n  note.txt: /wiki/spaces/TEST/pages/1/Page\n"
		path := oskit.Create(t, content, t.TempDir(), configFile)

		// --- When ---
		have, err := loadConfig(rng, path)

		// --- Then ---
		assert.Nil(t, have)
		assert.ErrorContain(t, "must end in .md", err)
	})

	t.Run("parses the timeout duration", func(t *testing.T) {
		// --- Given ---
		rng := ring.New(ring.WithEnv(secretEnv()))
		content := "timeout: 45s\n"
		path := oskit.Create(t, content, t.TempDir(), configFile)

		// --- When ---
		have, err := loadConfig(rng, path)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, 45*time.Second, have.Timeout)
	})
}

func Test_rejectEnvKeys(t *testing.T) {
	t.Run("allows a file without env keys", func(t *testing.T) {
		// --- Given ---
		data := []byte("pages:\n  a.md: /wiki/spaces/T/pages/1/P\n")

		// --- When ---
		err := rejectEnvKeys(data)

		// --- Then ---
		assert.NoError(t, err)
	})

	t.Run("ignores malformed YAML", func(t *testing.T) {
		// --- Given ---
		data := []byte("timeout: : : bad\n\t- nope\n")

		// --- When ---
		err := rejectEnvKeys(data)

		// --- Then ---
		assert.NoError(t, err)
	})
}

func Test_rejectEnvKeys_tabular(t *testing.T) {
	tt := []struct {
		testN   string
		data    string
		wantErr string
	}{
		{"host", "host: https://ex.atlassian.net\n", `"host" must not be set`},
		{"account", "account: a@ex.com\n", `"account" must not be set`},
		{"token", "token: secret\n", `"token" must not be set`},
		{"work_dir", "work_dir: wd\n", `"work_dir" must not be set`},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			err := rejectEnvKeys([]byte(tc.data))

			// --- Then ---
			assert.ErrorContain(t, tc.wantErr, err)
		})
	}
}

func Test_loadEnvFile(t *testing.T) {
	t.Run("loads variables into the ring", func(t *testing.T) {
		// --- Given ---
		rng := ring.New(ring.WithEnv(nil))
		content := "CFSYNC_HOST=https://ex.atlassian.net\nCFSYNC_TOKEN=secret\n"
		path := oskit.Create(t, content, t.TempDir(), envFile)

		// --- When ---
		err := loadEnvFile(rng, path, true)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "https://ex.atlassian.net", rng.EnvGet("CFSYNC_HOST"))
		assert.Equal(t, "secret", rng.EnvGet("CFSYNC_TOKEN"))
	})

	t.Run("an environment value wins over the file", func(t *testing.T) {
		// --- Given ---
		rng := ring.New(ring.WithEnv([]string{"CFSYNC_TOKEN=from-env"}))
		path := oskit.Create(t, "CFSYNC_TOKEN=from-file\n", t.TempDir(), envFile)

		// --- When ---
		err := loadEnvFile(rng, path, true)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "from-env", rng.EnvGet("CFSYNC_TOKEN"))
	})

	t.Run("skips comments and blanks and strips quotes", func(t *testing.T) {
		// --- Given ---
		rng := ring.New(ring.WithEnv(nil))
		content := "# a comment\n\nCFSYNC_ACCOUNT=\"a@ex.com\"\n"
		path := oskit.Create(t, content, t.TempDir(), envFile)

		// --- When ---
		err := loadEnvFile(rng, path, true)

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "a@ex.com", rng.EnvGet("CFSYNC_ACCOUNT"))
	})

	t.Run("a missing file is silent when not explicit", func(t *testing.T) {
		// --- Given ---
		rng := ring.New(ring.WithEnv(nil))
		path := filepath.Join(t.TempDir(), "nope")

		// --- When ---
		err := loadEnvFile(rng, path, false)

		// --- Then ---
		assert.NoError(t, err)
	})

	t.Run("an empty path selects .env and stays silent", func(t *testing.T) {
		// --- Given ---
		rng := ring.New(ring.WithEnv(nil))
		t.Chdir(t.TempDir())

		// --- When ---
		err := loadEnvFile(rng, "", false)

		// --- Then ---
		assert.NoError(t, err)
	})

	t.Run("error - an explicit missing file", func(t *testing.T) {
		// --- Given ---
		rng := ring.New(ring.WithEnv(nil))
		path := filepath.Join(t.TempDir(), "nope")

		// --- When ---
		err := loadEnvFile(rng, path, true)

		// --- Then ---
		assert.ErrorContain(t, "reading env file", err)
	})
}

func Test_config_reqTimeout(t *testing.T) {
	t.Run("returns the configured timeout", func(t *testing.T) {
		// --- Given ---
		cfg := &config{Timeout: 45 * time.Second}

		// --- When ---
		have := cfg.reqTimeout()

		// --- Then ---
		assert.Equal(t, 45*time.Second, have)
	})

	t.Run("falls back to the default when non-positive", func(t *testing.T) {
		// --- Given ---
		cfg := &config{}

		// --- When ---
		have := cfg.reqTimeout()

		// --- Then ---
		assert.Equal(t, defaultTimeout, have)
	})
}

func Test_config_domain_tabular(t *testing.T) {
	tt := []struct {
		testN string
		host  string
		want  string
	}{
		{"https host", "https://ex.atlassian.net", "ex.atlassian.net"},
		{"http host", "http://ex.atlassian.net", "ex.atlassian.net"},
		{"host with port", "http://127.0.0.1:8080", "127.0.0.1:8080"},
		{
			"trailing path is dropped",
			"https://ex.atlassian.net/wiki",
			"ex.atlassian.net",
		},
		{"bare host without scheme", "ex.atlassian.net", "ex.atlassian.net"},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- Given ---
			cfg := &config{Host: tc.host}

			// --- When ---
			have := cfg.domain()

			// --- Then ---
			assert.Equal(t, tc.want, have)
		})
	}
}

func Test_config_override(t *testing.T) {
	t.Run("overrides only non-empty variables", func(t *testing.T) {
		// --- Given ---
		env := []string{"CFSYNC_HOST=https://env.atlassian.net"}
		rng := ring.New(ring.WithEnv(env))
		cfg := &config{
			Host:    "https://file.atlassian.net",
			Account: "file@ex.com",
			Token:   "file-token",
		}

		// --- When ---
		cfg.override(rng)

		// --- Then ---
		assert.Equal(t, "https://env.atlassian.net", cfg.Host)
		assert.Equal(t, "file@ex.com", cfg.Account)
		assert.Equal(t, "file-token", cfg.Token)
	})

	t.Run("empty variable does not override", func(t *testing.T) {
		// --- Given ---
		rng := ring.New(ring.WithEnv([]string{"CFSYNC_TOKEN="}))
		cfg := &config{Token: "file-token"}

		// --- When ---
		cfg.override(rng)

		// --- Then ---
		assert.Equal(t, "file-token", cfg.Token)
	})

	t.Run("overrides work_dir", func(t *testing.T) {
		// --- Given ---
		rng := ring.New(ring.WithEnv([]string{"CFSYNC_WORK_DIR=env-wd"}))
		cfg := &config{WorkDir: "file-wd"}

		// --- When ---
		cfg.override(rng)

		// --- Then ---
		assert.Equal(t, "env-wd", cfg.WorkDir)
	})
}

func Test_config_validate(t *testing.T) {
	// --- Given ---
	cfg := &config{
		Host:    "https://ex.atlassian.net",
		Account: "a@ex.com",
		Token:   "secret",
		WorkDir: "wd",
	}

	// --- When ---
	err := cfg.validate()

	// --- Then ---
	assert.NoError(t, err)
}

func Test_config_validate_combined_sources(t *testing.T) {
	// --- Given ---
	cfg := &config{
		Host:    "https://ex.atlassian.net",
		Account: "a@ex.com",
		Token:   "secret",
		WorkDir: "wd",
		Pages:   map[string]string{"a.md": "/wiki/spaces/T/pages/1/P"},
		Folders: map[string]string{"docs": "/wiki/spaces/T/folder/2"},
		Spaces:  map[string]string{"team": "/wiki/spaces/TEST"},
	}

	// --- When ---
	err := cfg.validate()

	// --- Then ---
	assert.NoError(t, err)
}

func Test_config_validate_tabular(t *testing.T) {
	tt := []struct {
		testN   string
		cfg     *config
		wantErr string
	}{
		{
			"error - missing host",
			&config{Account: "a@ex.com", Token: "secret"},
			"host is required",
		},
		{
			"error - missing account",
			&config{
				Host:  "https://ex.atlassian.net",
				Token: "secret",
			},
			"account is required",
		},
		{
			"error - missing token",
			&config{
				Host:    "https://ex.atlassian.net",
				Account: "a@ex.com",
			},
			"token is required",
		},
		{
			"error - missing work_dir",
			&config{
				Host:    "https://ex.atlassian.net",
				Account: "a@ex.com",
				Token:   "secret",
			},
			"work_dir is required",
		},
		{
			"error - host is not https",
			&config{
				Host:    "http://ex.atlassian.net",
				Account: "a@ex.com",
				Token:   "secret",
				WorkDir: "wd",
			},
			"must be an https URL",
		},
		{
			"error - host is not absolute",
			&config{
				Host:    "ex.atlassian.net",
				Account: "a@ex.com",
				Token:   "secret",
				WorkDir: "wd",
			},
			"must be an https URL",
		},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			err := tc.cfg.validate()

			// --- Then ---
			assert.ErrorContain(t, tc.wantErr, err)
		})
	}
}

func Test_config_resolve(t *testing.T) {
	t.Run("resolves relative work_dir against the config dir", func(t *testing.T) {
		// --- Given ---
		cfg := &config{WorkDir: "wd"}

		// --- When ---
		err := cfg.resolve("/base")

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "/base/wd", cfg.WorkDir)
	})

	t.Run("keeps an absolute work_dir", func(t *testing.T) {
		// --- Given ---
		cfg := &config{WorkDir: "/abs/wd"}

		// --- When ---
		err := cfg.resolve("/base")

		// --- Then ---
		assert.NoError(t, err)
		assert.Equal(t, "/abs/wd", cfg.WorkDir)
	})

	t.Run("resolves page keys under work_dir", func(t *testing.T) {
		// --- Given ---
		cfg := &config{
			WorkDir: "wd",
			Pages: map[string]string{
				"a/b.md": "/wiki/spaces/TEST/pages/1/Page",
				"c.md":   "/wiki/spaces/DOCS/folder/",
			},
		}

		// --- When ---
		err := cfg.resolve("/base")

		// --- Then ---
		assert.NoError(t, err)
		want := map[string]string{
			"/base/wd/a/b.md": "/wiki/spaces/TEST/pages/1/Page",
			"/base/wd/c.md":   "/wiki/spaces/DOCS/folder/",
		}
		assert.Equal(t, want, cfg.Pages)
	})

	t.Run("allows empty pages", func(t *testing.T) {
		// --- Given ---
		cfg := &config{WorkDir: "wd"}

		// --- When ---
		err := cfg.resolve("/base")

		// --- Then ---
		assert.NoError(t, err)
		assert.Nil(t, cfg.Pages)
	})

	t.Run("error - empty source", func(t *testing.T) {
		// --- Given ---
		cfg := &config{WorkDir: "wd", Pages: map[string]string{"a.md": ""}}

		// --- When ---
		err := cfg.resolve("/base")

		// --- Then ---
		assert.ErrorContain(t, "empty source", err)
	})

	t.Run("error - keys resolve to the same destination", func(t *testing.T) {
		// --- Given ---
		cfg := &config{
			WorkDir: "wd",
			Pages: map[string]string{
				"a/b.md":   "/wiki/spaces/TEST/pages/1/Page",
				"a/./b.md": "/wiki/spaces/TEST/pages/2/Page",
			},
		}

		// --- When ---
		err := cfg.resolve("/base")

		// --- Then ---
		assert.ErrorContain(t, "same destination", err)
	})

	t.Run("error - keys refer to the same page id", func(t *testing.T) {
		// --- Given ---
		cfg := &config{
			WorkDir: "wd",
			Pages: map[string]string{
				"a.md": "/wiki/spaces/TEST/pages/1/Page",
				"b.md": "/wiki/spaces/TEST/pages/1/Page+Copy",
			},
		}

		// --- When ---
		err := cfg.resolve("/base")

		// --- Then ---
		assert.ErrorContain(t, "same page", err)
	})

	t.Run("resolves folder keys under work_dir", func(t *testing.T) {
		// --- Given ---
		cfg := &config{
			WorkDir: "wd",
			Folders: map[string]string{
				"docs": "/wiki/spaces/DOCS/folder/100",
			},
		}

		// --- When ---
		err := cfg.resolve("/base")

		// --- Then ---
		assert.NoError(t, err)
		want := map[string]string{
			"/base/wd/docs": "/wiki/spaces/DOCS/folder/100",
		}
		assert.Equal(t, want, cfg.Folders)
	})

	t.Run("error - folder empty source", func(t *testing.T) {
		// --- Given ---
		cfg := &config{WorkDir: "wd", Folders: map[string]string{"docs": ""}}

		// --- When ---
		err := cfg.resolve("/base")

		// --- Then ---
		assert.ErrorContain(t, "empty source", err)
	})

	t.Run("error - folder source is not a folder", func(t *testing.T) {
		// --- Given ---
		cfg := &config{
			WorkDir: "wd",
			Folders: map[string]string{
				"docs": "/wiki/spaces/DOCS/pages/1/Page",
			},
		}

		// --- When ---
		err := cfg.resolve("/base")

		// --- Then ---
		assert.ErrorContain(t, "is not a folder", err)
	})

	t.Run("error - folder keys share a destination", func(t *testing.T) {
		// --- Given ---
		cfg := &config{
			WorkDir: "wd",
			Folders: map[string]string{
				"docs":     "/wiki/spaces/DOCS/folder/100",
				"docs/./.": "/wiki/spaces/DOCS/folder/200",
			},
		}

		// --- When ---
		err := cfg.resolve("/base")

		// --- Then ---
		assert.ErrorContain(t, "same destination", err)
	})

	t.Run("resolves space keys under work_dir", func(t *testing.T) {
		// --- Given ---
		cfg := &config{
			WorkDir: "wd",
			Spaces: map[string]string{
				"team": "/wiki/spaces/TEST",
			},
		}

		// --- When ---
		err := cfg.resolve("/base")

		// --- Then ---
		assert.NoError(t, err)
		want := map[string]string{
			"/base/wd/team": "/wiki/spaces/TEST",
		}
		assert.Equal(t, want, cfg.Spaces)
	})

	t.Run("error - space empty source", func(t *testing.T) {
		// --- Given ---
		cfg := &config{WorkDir: "wd", Spaces: map[string]string{"team": ""}}

		// --- When ---
		err := cfg.resolve("/base")

		// --- Then ---
		assert.ErrorContain(t, "empty source", err)
	})

	t.Run("error - space source is not a space root", func(t *testing.T) {
		// --- Given ---
		cfg := &config{
			WorkDir: "wd",
			Spaces: map[string]string{
				"team": "/wiki/spaces/TEST/pages/1/Page",
			},
		}

		// --- When ---
		err := cfg.resolve("/base")

		// --- Then ---
		assert.ErrorContain(t, "is not a space root", err)
	})

	t.Run("error - space keys share a destination", func(t *testing.T) {
		// --- Given ---
		cfg := &config{
			WorkDir: "wd",
			Spaces: map[string]string{
				"team":     "/wiki/spaces/TEST",
				"team/./.": "/wiki/spaces/DOCS",
			},
		}

		// --- When ---
		err := cfg.resolve("/base")

		// --- Then ---
		assert.ErrorContain(t, "same destination", err)
	})

	t.Run("error - folder and space share a destination", func(t *testing.T) {
		// --- Given ---
		cfg := &config{
			WorkDir: "wd",
			Folders: map[string]string{
				"docs": "/wiki/spaces/DOCS/folder/100",
			},
			Spaces: map[string]string{
				"docs": "/wiki/spaces/TEAM",
			},
		}

		// --- When ---
		err := cfg.resolve("/base")

		// --- Then ---
		assert.ErrorContain(t, "same destination", err)
	})
}

func Test_validateDest(t *testing.T) {
	// --- When ---
	err := validateDest("a/b.md")

	// --- Then ---
	assert.NoError(t, err)
}

func Test_validateDest_tabular(t *testing.T) {
	tt := []struct {
		testN   string
		dest    string
		wantErr string
	}{
		{"empty", "", "is empty"},
		{"absolute", "/abs/x.md", "must be relative"},
		{"not markdown", "note.txt", "must end in .md"},
		{"no extension", "note", "must end in .md"},
		{"escapes work_dir", "../x.md", "escapes work_dir"},
		{"escapes work_dir nested", "a/../../x.md", "escapes work_dir"},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			err := validateDest(tc.dest)

			// --- Then ---
			assert.ErrorContain(t, tc.wantErr, err)
		})
	}
}

func Test_validateRoot(t *testing.T) {
	// --- When ---
	err := validateRoot("docs/sub")

	// --- Then ---
	assert.NoError(t, err)
}

func Test_validateRoot_tabular(t *testing.T) {
	tt := []struct {
		testN   string
		root    string
		wantErr string
	}{
		{"empty", "", "is empty"},
		{"absolute", "/abs", "must be relative"},
		{"markdown", "docs.md", "must not end in .md"},
		{"escapes work_dir", "../x", "escapes work_dir"},
		{"escapes work_dir nested", "a/../../x", "escapes work_dir"},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			err := validateRoot(tc.root)

			// --- Then ---
			assert.ErrorContain(t, tc.wantErr, err)
		})
	}
}
