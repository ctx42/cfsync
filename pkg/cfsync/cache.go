// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/ctx42/cfsync/pkg/adf"
)

// page is a single Confluence page pulled from the Site. It is the value
// written, pretty-printed, to the ADF cache and the value [page.cacheFile]
// uses to build the cache file name.
type page struct {
	// Name is the page's destination name from the configuration Pages map,
	// relative to the work directory and ending in ".md".
	Name string `json:"name"`

	// ID is the numeric Confluence page identifier.
	ID string `json:"id"`

	// Title is the page title as stored in Confluence.
	Title string `json:"title"`

	// Version is the Confluence page version number.
	Version int `json:"version"`

	// SpaceID is the numeric identifier of the space the page belongs to.
	SpaceID string `json:"space_id"`

	// ParentID is the numeric id of the page's parent node — another page or
	// a folder — carried from the discovery walk for a folder or space page,
	// or from the page GET for a page pulled through pages:. It round-trips
	// into the rendered Markdown as the parent_id frontmatter field and is
	// omitted, both here and there, for a page with no parent, such as a
	// space homepage.
	ParentID string `json:"parent_id,omitempty"`

	// SpaceKey is the key of the space the page belongs to, set only for a page
	// pulled through a configured space. It round-trips into the rendered
	// Markdown as the space_key frontmatter field.
	SpaceKey string `json:"space_key,omitempty"`

	// Domain is the Confluence Site host the page was pulled from, such as
	// "example.atlassian.net". It round-trips into the rendered Markdown as the
	// cf_domain frontmatter field.
	Domain string `json:"cf_domain,omitempty"`

	// ADF is the page body in Atlassian Document Format, embedded verbatim.
	ADF json.RawMessage `json:"adf"`
}

// cacheFile returns the cache file name for pag relative to the cache
// directory. It mirrors the configuration name as subdirectories, drops the
// ".md" suffix, and appends the version, so "test/root_page_1.md" at version 5
// becomes "test/root_page_1.v5.json".
func (pag *page) cacheFile() string {
	base := strings.TrimSuffix(pag.Name, ".md")
	return fmt.Sprintf("%s.v%d.json", base, pag.Version)
}

// MarshalJSON implements [json.Marshaler], returning the page as pretty-printed
// JSON.
func (pag *page) MarshalJSON() ([]byte, error) {
	type alias page
	data, err := json.MarshalIndent((*alias)(pag), "", "  ")
	if err != nil {
		return nil, fmt.Errorf("encoding page %s: %w", pag.ID, err)
	}
	return data, nil
}

// write writes the page as pretty-printed wrapper JSON to the path, creating
// missing parent directories.
func (pag *page) write(path string) error {
	content, err := pag.MarshalJSON()
	if err != nil {
		return err
	}
	content = append(content, '\n')
	return writeFile(path, content, 0o600)
}

// doc parses the page into an [adf.ADF] document, round-tripping it through its
// wrapper JSON so the parsed document matches the cached ADF exactly.
func (pag *page) doc() (*adf.ADF, error) {
	data, err := pag.MarshalJSON()
	if err != nil {
		return nil, err
	}
	return adf.NewADF(data)
}
