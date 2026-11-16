/**
 * Sends a sealed draft: one multipart POST with the manifest and the files. A retry
 * sends the same capture (same id, same bytes), and the server answers the same issue.
 */

import { checkManifest, type AssetType, type CaptureDraft, type CaptureManifest, type CaptureReceipt, type ManifestAsset } from "../contract";

const SAVED = "Feedback did not send. Your draft is saved, so try again.";
export const SIGNED_OUT = "Your session has ended. Sign in again in another tab, then press Retry: your draft is saved.";

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The checked manifest for a sealed draft: its metadata and, for each file, kind, type, size and SHA-256. A site's own
 * transport (the `submit` prop) sends this, so its server can verify the bytes it receives the same way.
 */
export async function buildManifest(draft: CaptureDraft): Promise<CaptureManifest> {
  const assets: ManifestAsset[] = [];
  for (const kind of ["image", "recording"] as const) {
    const blob = draft[kind];
    if (!blob) continue;
    assets.push({ kind, type: (blob.type || (kind === "image" ? "image/png" : "video/webm")) as AssetType, size: blob.size, sha256: await sha256(blob) });
  }
  const checked = checkManifest({ metadata: draft.metadata, assets });
  if (!checked.ok) throw new Error(checked.why);
  return checked.value;
}

/** Sends a draft through a site's transport. The default is submitCapture: one multipart POST to the endpoint. */
export type SubmitCapture = (endpoint: string, draft: CaptureDraft) => Promise<CaptureReceipt>;

export const submitCapture: SubmitCapture = async (endpoint, draft) => {
  const manifest = await buildManifest(draft);
  const body = new FormData();
  body.set("manifest", JSON.stringify(manifest));
  if (draft.image) body.set("image", draft.image, "element.png");
  if (draft.recording) body.set("recording", draft.recording, draft.recording.type === "video/mp4" ? "recording.mp4" : "recording.webm");
  let response: Response;
  try {
    // A site that sends an expired session to its sign-in page answers with a redirect; following it would post the
    // capture to the sign-in page. Stop at the redirect and say what happened.
    response = await fetch(endpoint, { method: "POST", body, cache: "no-store", credentials: "same-origin", redirect: "manual" });
  } catch {
    throw new Error(SAVED);
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) throw new Error(SIGNED_OUT);
  if (response.status === 401) throw new Error(SIGNED_OUT);
  const result = (await response.json().catch(() => null)) as (CaptureReceipt & { error?: { message?: string } }) | null;
  if (!response.ok || !result?.identifier) throw new Error(result?.error?.message || SAVED);
  return { identifier: result.identifier, url: result.url };
};
