// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

// secretEnv returns the CFSYNC_* environment supplying the credentials and
// work_dir the config file no longer carries, for use with ring.WithEnv.
func secretEnv() []string {
	return []string{
		"CFSYNC_HOST=https://ex.atlassian.net",
		"CFSYNC_ACCOUNT=a@ex.com",
		"CFSYNC_TOKEN=secret",
		"CFSYNC_WORK_DIR=wd",
	}
}

// pageTpl is the v2 page-by-id response golden fixture, parameterized by
// pageData, with the ADF document embedded as the Atlas document format value.
const pageTpl = "testdata/page.tpl.yml"

// pageData parameterizes the pageTpl golden fixture.
type pageData struct {
	ID       string
	Title    string
	SpaceID  string
	ParentID string
	Version  int
	ADF      string
}
