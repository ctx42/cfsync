// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package cfsync

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/ctx42/testing/pkg/assert"
	"github.com/ctx42/testing/pkg/must"
	"github.com/ctx42/testkit/pkg/oskit"
)

func Test_page_cacheFile_tabular(t *testing.T) {
	tt := []struct {
		testN string
		page  *page
		want  string
	}{
		{
			"nested name",
			&page{Name: "test/root_page_1.md", Version: 5},
			"test/root_page_1.v5.json",
		},
		{
			"flat name",
			&page{Name: "root_page_1.md", Version: 12},
			"root_page_1.v12.json",
		},
	}

	for _, tc := range tt {
		t.Run(tc.testN, func(t *testing.T) {
			// --- When ---
			have := tc.page.cacheFile()

			// --- Then ---
			assert.Equal(t, tc.want, have)
		})
	}
}

func Test_page_MarshalJSON(t *testing.T) {
	t.Run("pretty-prints the envelope", func(t *testing.T) {
		// --- Given ---
		pag := &page{
			Name:    "test/root_page_1.md",
			ID:      "1975222283",
			Title:   "Test Root Page 1",
			Version: 5,
			SpaceID: "9",
			ADF:     json.RawMessage(`{"version":1,"type":"doc","content":[]}`),
		}

		// --- When ---
		have, err := pag.MarshalJSON()

		// --- Then ---
		assert.NoError(t, err)
		want := "" +
			"{\n" +
			"  \"name\": \"test/root_page_1.md\",\n" +
			"  \"id\": \"1975222283\",\n" +
			"  \"title\": \"Test Root Page 1\",\n" +
			"  \"version\": 5,\n" +
			"  \"space_id\": \"9\",\n" +
			"  \"adf\": {\n" +
			"    \"version\": 1,\n" +
			"    \"type\": \"doc\",\n" +
			"    \"content\": []\n" +
			"  }\n" +
			"}"
		assert.Equal(t, want, string(have))
	})

	t.Run("includes parent_id after space_id when set", func(t *testing.T) {
		// --- Given ---
		pag := &page{
			Name:     "test/root_page_1.md",
			ID:       "1975222283",
			Title:    "Test Root Page 1",
			Version:  5,
			SpaceID:  "9",
			ParentID: "77",
			ADF:      json.RawMessage(`{"version":1,"type":"doc","content":[]}`),
		}

		// --- When ---
		have, err := pag.MarshalJSON()

		// --- Then ---
		assert.NoError(t, err)
		want := "" +
			"{\n" +
			"  \"name\": \"test/root_page_1.md\",\n" +
			"  \"id\": \"1975222283\",\n" +
			"  \"title\": \"Test Root Page 1\",\n" +
			"  \"version\": 5,\n" +
			"  \"space_id\": \"9\",\n" +
			"  \"parent_id\": \"77\",\n" +
			"  \"adf\": {\n" +
			"    \"version\": 1,\n" +
			"    \"type\": \"doc\",\n" +
			"    \"content\": []\n" +
			"  }\n" +
			"}"
		assert.Equal(t, want, string(have))
	})

	t.Run("omits parent_id when unset", func(t *testing.T) {
		// --- Given ---
		pag := &page{
			Name:    "test/root_page_1.md",
			ID:      "1975222283",
			Title:   "Test Root Page 1",
			Version: 5,
			SpaceID: "9",
			ADF:     json.RawMessage(`{"version":1,"type":"doc","content":[]}`),
		}

		// --- When ---
		have, err := pag.MarshalJSON()

		// --- Then ---
		assert.NoError(t, err)
		assert.NotContain(t, "parent_id", string(have))
	})

	t.Run("error - body is not valid JSON", func(t *testing.T) {
		// --- Given ---
		pag := &page{ID: "7", ADF: json.RawMessage("not-json")}

		// --- When ---
		have, err := pag.MarshalJSON()

		// --- Then ---
		assert.Nil(t, have)
		assert.ErrorRegexp(t, "encoding page 7.*invalid character", err)
	})
}

func Test_page_write(t *testing.T) {
	t.Run("writes the page, creating parent dirs", func(t *testing.T) {
		// --- Given ---
		pag := &page{
			Name:    "test/root_page_1.md",
			ID:      "1975222283",
			Title:   "Test Root Page 1",
			Version: 5,
			SpaceID: "9",
			ADF:     json.RawMessage(`{"version":1,"type":"doc","content":[]}`),
		}
		path := filepath.Join(t.TempDir(), "test", "root_page_1.v5.json")

		// --- When ---
		err := pag.write(path)

		// --- Then ---
		assert.NoError(t, err)
		want := must.Value(pag.MarshalJSON())
		want = append(want, '\n')
		have := oskit.ReadFileStr(t, path)
		assert.Equal(t, string(want), have)
	})

	t.Run("error - body is not valid JSON", func(t *testing.T) {
		// --- Given ---
		pag := &page{ID: "7", ADF: json.RawMessage("not-json")}
		path := filepath.Join(t.TempDir(), "root_page_1.v5.json")

		// --- When ---
		err := pag.write(path)

		// --- Then ---
		assert.ErrorRegexp(t, "encoding page 7.*invalid character", err)
	})
}
