// SPDX-FileCopyrightText: (c) 2026 Rafal Zajac
// SPDX-License-Identifier: MIT

package adf

// Links translates page links between a Confluence document and its local
// Markdown rendering, for one document at a known location. It is supplied by
// the caller so the adf package stays ignorant of how pages map to local files.
//
// On render (see [ADF.MarshallMarkdownLinks]), ToLocal turns a Confluence href
// into a local Markdown link target; on reconstruct (see [ADF.PutLinks]),
// ToRemote turns a local target back into the Confluence href to push. The two
// are inverses for a link that survives a pull/push round trip, so an unedited
// document re-renders unchanged. A nil Links leaves every link untouched.
type Links interface {
	// ToLocal maps a Confluence href to a local Markdown link target and the
	// label to show for it. It returns ok false to leave the link unchanged.
	// The label is used only when an inlineCard, which carries no text of its
	// own, is rewritten into a "[label](target)" link; a text link keeps its
	// existing label.
	ToLocal(href string) (target, label string, ok bool)

	// ToRemote maps a local Markdown link target back to the Confluence href to
	// push. It returns ok false to leave the target unchanged.
	ToRemote(target string) (href string, ok bool)
}

// localLink returns the local target for a Confluence href, or the href
// unchanged when lnk is nil or does not map it.
func localLink(lnk Links, href string) string {
	if lnk == nil {
		return href
	}
	if target, _, ok := lnk.ToLocal(href); ok {
		return target
	}
	return href
}

// remoteLink returns the Confluence href for a local target, or the target
// unchanged when lnk is nil or does not map it.
func remoteLink(lnk Links, target string) string {
	if lnk == nil {
		return target
	}
	if href, ok := lnk.ToRemote(target); ok {
		return href
	}
	return target
}
