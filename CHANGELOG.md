# Changelog

## 0.1.0

First release, extracted from the Nudge widget (nudge-monorepo `packages/feedback-widget`) and its Aria OS port.

- `<FeedbackWidget>` with floating launcher, Cmd/Ctrl+Shift+F, element picker, DOM image, element or shared-surface recording with optional narration, per-tab 24-hour drafts, receipt.
- `createFeedbackHandler()` for the site's route: origin guard, site `authorize`, strict manifest, caps, Linear delivery with destination check, idempotent create by capture id, upload journal.
- Theme through `--fbw-*` CSS variables.
