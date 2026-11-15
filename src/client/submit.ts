/**
 * Sends a sealed draft: one multipart POST with the manifest and the files. A retry
 * sends the same capture (same id, same bytes), and the server answers the same issue.
 */

import { checkManifest, type AssetType, type CaptureDraft, type CaptureReceipt, type ManifestAsset } from "../contract";

const SAVED = "Feedback did not send. Your draft is saved, so try again.";

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function submitCapture(endpoint: string, draft: CaptureDraft): Promise<CaptureReceipt> {
  const assets: ManifestAsset[] = [];
  for (const kind of ["image", "recording"] as const) {
    const blob = draft[kind];
    if (!blob) continue;
    assets.push({ kind, type: (blob.type || (kind === "image" ? "image/png" : "video/webm")) as AssetType, size: blob.size, sha256: await sha256(blob) });
  }
  const checked = checkManifest({ metadata: draft.metadata, assets });
  if (!checked.ok) throw new Error(checked.why);
  const body = new FormData();
  body.set("manifest", JSON.stringify(checked.value));
  if (draft.image) body.set("image", draft.image, "element.png");
  if (draft.recording) body.set("recording", draft.recording, draft.recording.type === "video/mp4" ? "recording.mp4" : "recording.webm");
  let response: Response;
  try {
    response = await fetch(endpoint, { method: "POST", body, cache: "no-store", credentials: "same-origin" });
  } catch {
    throw new Error(SAVED);
  }
  const result = (await response.json().catch(() => null)) as (CaptureReceipt & { error?: { message?: string } }) | null;
  if (!response.ok || !result?.identifier) throw new Error(result?.error?.message || SAVED);
  return { identifier: result.identifier, url: result.url };
}
