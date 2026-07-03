// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package version

import "github.com/ctx42/testing/pkg/tester"

// saveBuildVars restores the injected build-metadata variables after the test.
func saveBuildVars(t tester.T) {
	t.Helper()
	rev, hash, date, state := buildRev, buildHash, buildDate, buildState
	t.Cleanup(func() {
		buildRev, buildHash, buildDate, buildState = rev, hash, date, state
	})
}
