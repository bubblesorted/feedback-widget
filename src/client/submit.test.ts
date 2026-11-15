/**
 * The browser's send: one multipart POST to the site's endpoint that never follows a redirect, so an expired session
 * reads as "sign in again" instead of posting the capture to a sign-in page.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CaptureDraft } from "../contract";
import { SIGNED_OUT, submitCapture } from "./submit";

const draft: CaptureDraft = {
  metadata: {
    id: "0f0e0d0c-0b0a-4900-8800-000000000002",
    note: "Text only",
    page: "/admin",
    capturedAt: "2026-11-15T08:00:00.000Z",
    viewport: { width: 100, height: 100 },
    target: null,
    recordingScope: null,
  },
  sealed: true,
  expiresAt: Date.now() + 60_000,
};

afterEach(() => vi.unstubAllGlobals());

describe("submitCapture", () => {
  it("posts the manifest to the site's endpoint without following redirects, and answers the receipt", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ identifier: "ASC-1", url: "https://x/l/ASC-1" }));
    vi.stubGlobal("fetch", fetch);
    expect(await submitCapture("/api/site-feedback", draft)).toEqual({ identifier: "ASC-1", url: "https://x/l/ASC-1" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/api/site-feedback");
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(String((init.body as FormData).get("manifest"))).metadata.id).toBe(draft.metadata.id);
  });

  it("an expired session (a redirect or a 401) says to sign in again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 307, headers: { location: "/signin" } })));
    await expect(submitCapture("/api/feedback", draft)).rejects.toThrow(SIGNED_OUT);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "unauthorized", message: "x" } }, { status: 401 })));
    await expect(submitCapture("/api/feedback", draft)).rejects.toThrow(SIGNED_OUT);
  });

  it("shows the server's own sentence for any other refusal, and a plain retry line when there is none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "not_configured", message: "Feedback is not set up on this server." } }, { status: 503 })));
    await expect(submitCapture("/api/feedback", draft)).rejects.toThrow("Feedback is not set up on this server.");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 500 })));
    await expect(submitCapture("/api/feedback", draft)).rejects.toThrow(/Your draft is saved/);
  });
});
