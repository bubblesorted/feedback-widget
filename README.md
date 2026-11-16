# @bubblesorted/feedback-widget

Embedded page feedback. A person points at part of a page, attaches an image of it and, if they want, a short screen recording, writes a note and sends it. Each send becomes one Linear issue in the site's configured destination. No extension, and no Linear account for the sender.

One widget, used by every site. A site supplies configuration only: who may send, where issues go, the product name and theme colours. Improve the widget here, publish a version, and every site picks it up through a dependency bump.

## What it does

- **Pick an element.** The outline follows the pointer. Click to hold, P and C for parent and child, Enter or "Use element" to take it. No other key reaches the page while the picker is up.
- **An image of the element is taken as soon as it is picked**, with Remove and Capture image to drop or retake it (a DOM render: canvas, cross-origin content and native controls may draw differently).
- **Record** the selected element (Chrome region capture, current tab) or a shared tab or window, with optional microphone narration. Stops at 45 seconds or 12 MB.
- **Preview, write, send.** Drafts live in the browser (IndexedDB), one per tab and per `draftScope`, for 24 hours, and survive navigation. A failed send keeps the sealed draft; Retry sends the same capture.
- **Idempotent.** The capture's UUID is the Linear issue id, so a retry, even after a lost response or a server restart, returns the same issue.
- **The browser cannot choose the destination.** The manifest is strict, and team, state, project and labels are server configuration.

## Use it on a site

Each version is a GitHub release, so a site needs no registry account:

```sh
npm install https://github.com/bubblesorted/feedback-widget/releases/download/v0.1.0/bubblesorted-feedback-widget-0.1.0.tgz
```

To update a site, install the newer release's URL. The lockfile pins the file's checksum.

### 1. The route

```ts
// app/api/feedback/route.ts (Next.js), or any handler that takes a Request
import { createFeedbackHandler } from "@bubblesorted/feedback-widget/server";

export const POST = createFeedbackHandler(() => ({
  product: "The Ascent", // title prefix: "[The Ascent] ..."
  linearApiKey: process.env.LINEAR_API_KEY,
  destination: { name: "ASC Backlog", teamId: "...", stateId: "...", labelIds: ["..."] /* projectId optional */ },
  authorize: async (request) => {
    const user = await currentUser(request);
    if (!user) return { ok: false, status: 401 };
    if (!user.isOwner) return { ok: false, status: 404 };
    return { ok: true, reporter: { id: user.id, email: user.email }, context: { organisation: user.orgName } };
  },
  receiptUrl: ({ identifier, url }) => url, // optional: where the receipt links
  footer: "Do not automatically start an agent.", // optional last line
  onError: ({ kind, code }) => console.warn("feedback failed", kind, code), // never gets the key or the note
}));
```

The handler refuses cross-site requests and a foreign `Origin`, then runs `authorize`, then checks the key (503 without it), then the body (multipart, at most 24 MB plus the manifest; each file at most 12 MB, matched to its SHA-256).

A capture can be up to about 24 MB. A platform with a smaller request-body limit (Vercel functions take 4.5 MB) needs a staged upload instead; that is not in this version. In Next.js with a `proxy.ts`/middleware, raise `experimental.proxyClientMaxBodySize` to at least 25 MB, or the body reaching the route is truncated (and refused).

### 2. The widget

```tsx
import "@bubblesorted/feedback-widget/styles.css";
import { FeedbackWidget } from "@bubblesorted/feedback-widget";

// Render it only for people who may send feedback. The route checks again.
<FeedbackWidget
  endpoint="/api/feedback"
  destinationLabel="The Ascent backlog in Linear"
  draftScope={`ascent:${user.id}`} // include the person, so a shared browser never restores another's draft
  launcher="floating" // or "none", and call openFeedback() from your own button or command palette
  shortcut // Cmd/Ctrl+Shift+F
  onSent={(receipt) => toast(`Sent as ${receipt.identifier}`)}
  className="my-feedback-theme"
/>;
```

`openFeedback()`, `closeFeedback()`, `toggleFeedback()`, `useFeedbackOpen()` and `useFeedbackAvailable()` let a site wire its own entry points.

### 3. The theme

Set any of these on `.fbw-root` or on your `className`. Nothing else should be restyled, so the widget stays one widget.

```css
.my-feedback-theme {
  --fbw-font: var(--font-sans);
  --fbw-bg: #fff;
  --fbw-sunk: #f4f5f7;
  --fbw-ink: #1b1c1f;
  --fbw-muted: #5f6672;
  --fbw-line: #e1e4e8;
  --fbw-accent: #1b1c1f;
  --fbw-accent-ink: #fff;
  --fbw-danger: #b42318;
  --fbw-radius: 14px;
  --fbw-radius-sm: 8px;
  --fbw-offset: 20px; /* distance from the viewport edge */
  --fbw-z: 2147483000;
}
```

## Privacy

- The target's text is its `aria-label` or visible text, cut to 160 characters. Input values and page HTML are never read.
- There is no background recorder. Screen sharing and the microphone ask for permission each time.
- The Linear key never reaches the browser, a response or a log.
- Evidence is uploaded to Linear and stays under the Linear workspace's access controls. There is no automatic masking yet: the sender reviews the image and recording before sending.

## Develop

```sh
npm install
npm test
npm run typecheck
npm run build
```

Release: bump `version`, add a CHANGELOG entry, commit, then `npm run release`. It checks, builds and packs the widget, tags `v<version>` and attaches the file to a GitHub release. Each site then installs the new release URL.
