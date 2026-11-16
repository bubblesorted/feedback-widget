/**
 * The feedback endpoint. A site mounts it as a POST route and passes its configuration:
 *
 *   export const POST = createFeedbackHandler(() => ({ product, linearApiKey, destination, authorize }));
 *
 * Checks, in order:
 *   1. POST only;
 *   2. same origin: Sec-Fetch-Site cross-site is refused, and so is an Origin naming another host;
 *   3. the site's authorize(): 401, 403 or 404 when it says no;
 *   4. the Linear key is set, else 503 not_configured;
 *   5. multipart/form-data, with a Content-Length of at most MAX_BODY_BYTES, and the bytes read counted against it;
 *   6. only the fields `manifest` (JSON, at most 32 KB), `image` and `recording` (files, at most 12 MB each);
 *   7. the strict manifest check: an unknown key anywhere, a destination included, is 400;
 *   8. each file the manifest lists must match its size, SHA-256 and format; a file it does not list is refused.
 * Then delivery: one capture at a time per id in this process (409 for a second), the journal so a retry does not
 * upload a file twice, and the issue created with the capture's id so a retry returns the same issue.
 */

import { createHash } from "node:crypto";

import { checkManifest, MAX_ASSET_BYTES, MAX_BODY_BYTES, MAX_MANIFEST_BYTES, DRAFT_TTL_MS, type AssetKind, type CaptureManifest, type CaptureReceipt, type ManifestAsset } from "../contract";
import { linearUrl, type FeedbackServerConfig } from "./config";
import { FeedbackError, sendCapture, STATUS, type CaptureAsset, type CaptureContext, type FeedbackCode } from "./linear";

const FIELDS = new Set(["manifest", "image", "recording"]);
const NO_CACHE = "no-store";
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const WEBM = Buffer.from("1a45dfa3", "hex");

export function errorResponse(code: FeedbackCode, message: string): Response {
  return Response.json({ error: { code, message } }, { status: STATUS[code], headers: { "Cache-Control": NO_CACHE } });
}

const mb = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

async function readLimited(request: Request, max: number): Promise<Buffer | null> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function hostOf(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("host") || (() => {
    try {
      return new URL(request.url).host;
    } catch {
      return null;
    }
  })();
}

/** Same origin, or an origin the site allows. Browsers send Origin on every POST, so a request without one is refused. */
export function sameOrigin(request: Request, allowed: string[] = []): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  if (allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === hostOf(request);
  } catch {
    return false;
  }
}

/** The file name a capture's asset is uploaded to Linear under. */
export function assetFileName(asset: ManifestAsset): string {
  return asset.kind === "image" ? "element.png" : `recording.${asset.type === "video/mp4" ? "mp4" : "webm"}`;
}

/** The bytes are the file the manifest names: its size, its hash and its format. A truncated body fails here. */
export function verifyAsset(asset: ManifestAsset, bytes: Buffer | undefined): asserts bytes is Buffer {
  if (!bytes) throw new FeedbackError("bad_request", "A file the capture lists did not arrive. Your draft is saved, so try again.");
  const format =
    asset.type === "image/png"
      ? bytes.subarray(0, 8).equals(PNG)
      : asset.type === "video/webm"
        ? bytes.subarray(0, 4).equals(WEBM)
        : bytes.subarray(4, 8).toString("latin1") === "ftyp";
  if (bytes.length !== asset.size || createHash("sha256").update(bytes).digest("hex") !== asset.sha256 || !format) {
    throw new FeedbackError("bad_request", "A file arrived incomplete or changed. Your draft is saved, so try again.");
  }
}

interface JournalEntry {
  at: number;
  assets: Record<string, string>;
  receipt?: CaptureReceipt;
  manifestHash: string;
}

export type FeedbackHandler = ((request: Request) => Promise<Response>) & {
  /** Test seam: forget deliveries in flight and the journal. */
  reset: () => void;
};

export function createFeedbackHandler(
  config: FeedbackServerConfig | (() => FeedbackServerConfig | Promise<FeedbackServerConfig>),
): FeedbackHandler {
  const inFlight = new Set<string>();
  const journal = new Map<string, JournalEntry>();

  const prune = (now: number) => {
    for (const [id, entry] of journal) if (now - entry.at > DRAFT_TTL_MS) journal.delete(id);
  };

  async function deliver(cfg: FeedbackServerConfig, key: string, manifest: CaptureManifest, files: Partial<Record<AssetKind, Buffer>>, server: CaptureContext): Promise<CaptureReceipt> {
    const id = manifest.metadata.id;
    const hash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    prune(Date.now());
    const prior = journal.get(id);
    if (prior && prior.manifestHash !== hash) {
      throw new FeedbackError("conflict", "This draft was already sent with different content. Discard it and start again.");
    }
    if (prior?.receipt) return prior.receipt;
    if (inFlight.has(id)) throw new FeedbackError("conflict", "This feedback is already being sent. Try again in a moment for its receipt.");
    inFlight.add(id);
    try {
      const assets: CaptureAsset[] = [];
      for (const asset of manifest.assets) {
        const bytes = files[asset.kind];
        verifyAsset(asset, bytes);
        assets.push({ name: assetFileName(asset), type: asset.type, bytes });
      }
      const entry: JournalEntry = prior ?? { at: Date.now(), assets: {}, manifestHash: hash };
      journal.set(id, entry);
      const issue = await sendCapture(manifest.metadata, server, assets, {
        access: { key, url: linearUrl(cfg.linearApiUrl) },
        product: cfg.product,
        destination: cfg.destination,
        footer: cfg.footer,
        journal: {
          cached: { ...entry.assets },
          remember: (name, url) => {
            entry.assets = { ...entry.assets, [name]: url };
          },
        },
      });
      const receipt: CaptureReceipt = { identifier: issue.identifier, url: cfg.receiptUrl ? cfg.receiptUrl(issue) : issue.url };
      entry.receipt = receipt;
      return receipt;
    } finally {
      inFlight.delete(id);
    }
  }

  const handler = async (request: Request): Promise<Response> => {
    let cfg: FeedbackServerConfig | undefined;
    try {
      cfg = typeof config === "function" ? await config() : config;
      if (request.method !== "POST") return errorResponse("bad_request", "Feedback takes POST only.");
      if (!sameOrigin(request, cfg.allowedOrigins)) return errorResponse("forbidden", "Feedback must come from this site.");
      const auth = await cfg.authorize(request);
      if (!auth.ok) {
        const code: FeedbackCode = auth.status === 401 ? "unauthorized" : auth.status === 403 ? "forbidden" : "not_found";
        return errorResponse(code, auth.message ?? (auth.status === 401 ? "Sign in to send feedback." : auth.status === 403 ? "You cannot send feedback here." : "Not found."));
      }
      const key = cfg.linearApiKey?.trim();
      if (!key) return errorResponse("not_configured", "Feedback is not set up on this server.");
      const type = (request.headers.get("content-type") ?? "").trim();
      if (!/^multipart\/form-data\s*;.*boundary=/i.test(type)) return errorResponse("unsupported_media_type", "Send the capture as multipart/form-data.");
      const length = request.headers.get("content-length");
      if (length === null || !/^\d+$/.test(length.trim())) return errorResponse("bad_request", "A capture must give its Content-Length.");
      if (Number(length) > MAX_BODY_BYTES) return errorResponse("too_large", `The capture is over ${mb(MAX_BODY_BYTES)}.`);

      const body = await readLimited(request, MAX_BODY_BYTES);
      if (body === null) return errorResponse("too_large", `The capture is over ${mb(MAX_BODY_BYTES)}.`);
      let form: FormData;
      try {
        form = await new Response(new Uint8Array(body), { headers: { "content-type": type } }).formData();
      } catch {
        return errorResponse("bad_request", "The capture is not valid multipart/form-data.");
      }
      for (const name of new Set(form.keys())) {
        if (!FIELDS.has(name)) return errorResponse("bad_request", `The capture has an unknown field, ${name.slice(0, 40)}.`);
        if (form.getAll(name).length > 1) return errorResponse("bad_request", `The capture has ${name} twice.`);
      }
      const raw = form.get("manifest");
      if (typeof raw !== "string") return errorResponse("bad_request", "The capture has no manifest.");
      if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) return errorResponse("too_large", "The capture's details are over 32 KB.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return errorResponse("bad_json", "The capture's manifest is not valid JSON.");
      }
      const checked = checkManifest(parsed);
      if (!checked.ok) return errorResponse("bad_request", checked.why);
      const manifest = checked.value;
      const files: Partial<Record<AssetKind, Buffer>> = {};
      for (const kind of ["image", "recording"] as AssetKind[]) {
        const part = form.get(kind);
        if (part === null) continue;
        if (typeof part === "string") return errorResponse("bad_request", `The capture's ${kind} is not a file.`);
        if (part.size > MAX_ASSET_BYTES) return errorResponse("too_large", `The capture's ${kind} is over 12 MB.`);
        if (!manifest.assets.some((a) => a.kind === kind)) return errorResponse("bad_request", `The capture sent an ${kind} its manifest does not list.`);
        files[kind] = Buffer.from(await part.arrayBuffer());
      }
      const receipt = await deliver(cfg, key, manifest, files, { reporter: auth.reporter, context: auth.context });
      return Response.json(receipt, { headers: { "Cache-Control": NO_CACHE } });
    } catch (error) {
      if (error instanceof FeedbackError) {
        cfg?.onError?.({ kind: "FeedbackError", code: error.code });
        return errorResponse(error.code, error.message);
      }
      cfg?.onError?.({ kind: error instanceof Error ? error.name : "unknown", code: "upstream_failed" });
      return errorResponse("upstream_failed", "Feedback could not be confirmed. Your draft is saved, so try again.");
    }
  };

  return Object.assign(handler, {
    reset: () => {
      inFlight.clear();
      journal.clear();
    },
  });
}
