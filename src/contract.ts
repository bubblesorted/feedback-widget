/**
 * What the browser sends and what the server answers. Plain TypeScript with no imports, so the panel and the server
 * share one validator.
 *
 * The browser sends a manifest (the capture's metadata and, for each file, its kind, type, size and SHA-256) and at
 * most one PNG and one recording. The manifest is strict: an unknown key anywhere is refused, so a caller can never
 * name a team, project, state or label. The destination is each site's server configuration.
 */

export const MAX_ASSET_BYTES = 12 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 32 * 1024;
/** The whole multipart body: the manifest, two files and the part headers and boundaries. */
export const MAX_BODY_BYTES = 2 * MAX_ASSET_BYTES + MAX_MANIFEST_BYTES + 32 * 1024;
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_RECORDING_MS = 45_000;
export const MAX_NOTE_CHARS = 4000;

export type AssetKind = "image" | "recording";
export type AssetType = "image/png" | "video/webm" | "video/mp4";
export type RecordingScope = "element" | "shared-surface";

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureTarget {
  selector: string;
  tag: string;
  text: string;
  rect: CaptureRect;
}

export interface CaptureMetadata {
  /** The capture's UUID, which is also the Linear issue's id. */
  id: string;
  note: string;
  /** The path (and query) the capture was taken on. */
  page: string;
  capturedAt: string;
  viewport: { width: number; height: number };
  target: CaptureTarget | null;
  recordingScope: RecordingScope | null;
}

export interface ManifestAsset {
  kind: AssetKind;
  type: AssetType;
  size: number;
  sha256: string;
}

export interface CaptureManifest {
  metadata: CaptureMetadata;
  assets: ManifestAsset[];
}

export interface CaptureReceipt {
  identifier: string;
  url: string;
}

export interface CaptureDraft {
  metadata: CaptureMetadata;
  image?: Blob;
  recording?: Blob;
  sealed: boolean;
  expiresAt: number;
}

/** The error body every refusal uses. */
export interface FeedbackErrorBody {
  error: { code: string; message: string };
}

export type Checked<T> = { ok: true; value: T } | { ok: false; why: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

type Obj = Record<string, unknown>;

class Invalid extends Error {}

function fail(why: string): never {
  throw new Invalid(why);
}

function object(v: unknown, what: string, keys: readonly string[]): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(`${what} is not an object.`);
  const o = v as Obj;
  for (const k of Object.keys(o)) if (!keys.includes(k)) fail(`${what} has an unknown field, ${k.slice(0, 40)}.`);
  for (const k of keys) if (!(k in o)) fail(`${what} is missing ${k}.`);
  return o;
}

function text(v: unknown, what: string, max: number, min = 0): string {
  if (typeof v !== "string") fail(`${what} is not text.`);
  if (v.length > max) fail(`${what} is longer than ${max} characters.`);
  if (v.trim().length < min) fail(`${what} is empty.`);
  return v;
}

function num(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${what} is not a number.`);
  return v;
}

function positiveInt(v: unknown, what: string, max = Number.MAX_SAFE_INTEGER): number {
  const n = num(v, what);
  if (!Number.isInteger(n) || n <= 0 || n > max) fail(`${what} is out of range.`);
  return n;
}

function target(v: unknown): CaptureTarget | null {
  if (v === null) return null;
  const t = object(v, "The target", ["selector", "tag", "text", "rect"]);
  const r = object(t.rect, "The target's box", ["x", "y", "width", "height"]);
  const width = num(r.width, "The target's width");
  const height = num(r.height, "The target's height");
  if (width <= 0 || height <= 0) fail("The target has no size.");
  return {
    selector: text(t.selector, "The target's selector", 2000),
    tag: text(t.tag, "The target's tag", 40),
    text: text(t.text, "The target's text", 160),
    rect: { x: num(r.x, "The target's x"), y: num(r.y, "The target's y"), width, height },
  };
}

function metadata(v: unknown): CaptureMetadata {
  const m = object(v, "The capture", ["id", "note", "page", "capturedAt", "viewport", "target", "recordingScope"]);
  const id = text(m.id, "The capture id", 36);
  if (!UUID.test(id)) fail("The capture id is not a UUID.");
  const page = text(m.page, "The page", 2000);
  if (!page.startsWith("/") || page.startsWith("//")) fail("The page is not a path.");
  const capturedAt = text(m.capturedAt, "The capture time", 40);
  if (!ISO.test(capturedAt) || Number.isNaN(Date.parse(capturedAt))) fail("The capture time is not an ISO time.");
  const vp = object(m.viewport, "The viewport", ["width", "height"]);
  const scope = m.recordingScope;
  if (scope !== null && scope !== "element" && scope !== "shared-surface") fail("The recording scope is not known.");
  return {
    id: id.toLowerCase(),
    note: text(m.note, "The note", MAX_NOTE_CHARS, 1),
    page,
    capturedAt,
    viewport: {
      width: positiveInt(vp.width, "The viewport width", 100_000),
      height: positiveInt(vp.height, "The viewport height", 100_000),
    },
    target: target(m.target),
    recordingScope: scope,
  };
}

function asset(v: unknown): ManifestAsset {
  const a = object(v, "A file", ["kind", "type", "size", "sha256"]);
  if (a.kind !== "image" && a.kind !== "recording") fail("A file's kind is not known.");
  if (a.type !== "image/png" && a.type !== "video/webm" && a.type !== "video/mp4") fail("A file's type is not allowed.");
  if ((a.kind === "image") !== (a.type === "image/png")) fail("A file's type does not match its kind.");
  const sha256 = text(a.sha256, "A file's hash", 64);
  if (!SHA256.test(sha256)) fail("A file's hash is not a SHA-256.");
  return { kind: a.kind, type: a.type, size: positiveInt(a.size, "A file's size", MAX_ASSET_BYTES), sha256 };
}

/** Checks a manifest the browser sent. Strict: an unknown key anywhere is refused. */
export function checkManifest(input: unknown): Checked<CaptureManifest> {
  try {
    const o = object(input, "The manifest", ["metadata", "assets"]);
    const meta = metadata(o.metadata);
    if (!Array.isArray(o.assets) || o.assets.length > 2) fail("The manifest lists more than two files.");
    const assets = o.assets.map(asset);
    if (new Set(assets.map((a) => a.kind)).size !== assets.length) fail("The manifest lists one kind of file twice.");
    if (assets.some((a) => a.kind === "recording") !== (meta.recordingScope !== null)) {
      fail("The recording scope does not match the files.");
    }
    if ((assets.some((a) => a.kind === "image") || meta.recordingScope === "element") && !meta.target) {
      fail("An element capture needs its element.");
    }
    return { ok: true, value: { metadata: meta, assets } };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, why: e.message };
    throw e;
  }
}

/** The issue title: "[Product] " and the note's first line, cut to about 80 characters on a word. */
export function issueTitle(product: string, note: string): string {
  const prefix = product ? `[${product}] ` : "";
  const first = note.trim().split("\n")[0]?.trim() ?? "";
  if (first.length <= 80) return `${prefix}${first}`;
  const cut = first.slice(0, 80);
  const space = cut.lastIndexOf(" ");
  return `${prefix}${(space > 50 ? cut.slice(0, space) : cut).trimEnd()}...`;
}
