# Changelog

## 0.3.0

- A sent capture no longer comes back after a reload: the stored draft becomes a fresh one as soon as the receipt arrives.
- Every `openFeedback()` moves focus into the panel, even when it is already open, and again on the next frame, so a menu or command palette that hands focus back to its trigger as it closes does not keep it.
- A panel that fails to download (offline, or a deploy removed the old file) shows "Feedback could not load" with Try again and Close, instead of throwing into the host page's error boundary.
- `destination.stateType` (optional): the type the destination state must have, e.g. "triage", checked before every send.

## 0.2.0

- `submit` prop on `<FeedbackWidget>`: a site's own transport replaces the default multipart POST, for hosts that cap request bodies (Vercel: 4.5 MB). `buildManifest` and `submitCapture` are exported for it.
- `@bubblesorted/feedback-widget/server` exports `sendCapture`, `checkManifest`, `verifyAsset`, `assetFileName` and `linearUrl`, so a site's own route can deliver a capture it received another way.

## 0.1.2

- A picked heading's image no longer draws its text low and cut off (the renderer stripped the element's margin and the browser's default came back).
- The preview shows a small image at its own size instead of blowing it up.

## 0.1.1

- The element's image is taken as soon as it is picked. Remove and Capture image still drop or retake it.

## 0.1.0

First release, extracted from the Nudge widget (nudge-monorepo `packages/feedback-widget`) and its Aria OS port.

- `<FeedbackWidget>` with floating launcher, Cmd/Ctrl+Shift+F, element picker, DOM image, element or shared-surface recording with optional narration, per-tab 24-hour drafts, receipt.
- `createFeedbackHandler()` for the site's route: origin guard, site `authorize`, strict manifest, caps, Linear delivery with destination check, idempotent create by capture id, upload journal.
- Theme through `--fbw-*` CSS variables.
