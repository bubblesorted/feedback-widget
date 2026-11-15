/**
 * Linear for feedback capture: GraphQL with the site's key.
 *
 * The capture's UUID is the issue's id, so Linear's unique id is the last guard against a duplicate: before creating,
 * and again after a create that failed or lost its answer, the issue is looked up by that id. A receipt marker (a
 * hash of the capture) in the description tells our issue from a different one that took the id.
 *
 * Errors carry a plain sentence for the panel. Nothing here logs; no message ever holds the key, a URL or a provider
 * body.
 */

import { createHash } from "node:crypto";

import { issueTitle, type CaptureMetadata } from "../contract";
import type { LinearDestination, Reporter } from "./config";

export const KEY_REJECTED = "Linear rejected the feedback key.";
export const KEY_FORBIDDEN = "The feedback key lacks permission for the destination team.";

export type FeedbackCode =
  | "bad_request"
  | "bad_json"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "too_large"
  | "unsupported_media_type"
  | "upstream_failed"
  | "not_configured";

export const STATUS: Record<FeedbackCode, number> = {
  bad_request: 400,
  bad_json: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  unsupported_media_type: 415,
  upstream_failed: 502,
  not_configured: 503,
};

/** A failure the handler answers as it is: its code and one plain sentence. */
export class FeedbackError extends Error {
  constructor(
    readonly code: FeedbackCode,
    message: string,
  ) {
    super(message);
    this.name = "FeedbackError";
  }
}

export interface LinearAccess {
  key: string;
  url: string;
}

export interface CaptureAsset {
  name: string;
  type: string;
  bytes: Buffer;
}

/** The uploaded-asset journal: asset URLs already uploaded for this capture, by file name. */
export interface AssetJournal {
  cached: Record<string, string>;
  remember: (name: string, url: string) => void;
}

/** What the server adds to the capture: never the browser's to say. */
export interface CaptureContext {
  reporter?: Reporter;
  context?: Record<string, unknown>;
}

interface Issue {
  identifier: string;
  url: string;
  description: string | null;
}

interface GraphQLError {
  message?: string;
  extensions?: { code?: string; type?: string };
}

function authError(e: GraphQLError): boolean {
  const code = e.extensions?.code ?? "";
  const type = e.extensions?.type ?? "";
  return code === "AUTHENTICATION_ERROR" || /authentication/i.test(type);
}

function forbiddenError(e: GraphQLError): boolean {
  const code = e.extensions?.code ?? "";
  const type = e.extensions?.type ?? "";
  return code === "FORBIDDEN" || /forbidden/i.test(type) || /permission|forbidden/i.test(e.message ?? "");
}

function notFoundError(e: GraphQLError): boolean {
  return /not ?found/i.test(e.message ?? "") || /not ?found/i.test(e.extensions?.type ?? "");
}

export class LinearNotFound extends Error {}

async function query<T>(access: LinearAccess, text: string, variables: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(access.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: access.key },
      body: JSON.stringify({ query: text, variables }),
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
  } catch {
    throw new FeedbackError("upstream_failed", "Linear did not answer. Your draft is saved, so try again.");
  }
  if (response.status === 401) throw new FeedbackError("upstream_failed", KEY_REJECTED);
  if (response.status === 403) throw new FeedbackError("upstream_failed", KEY_FORBIDDEN);
  const body = (await response.json().catch(() => null)) as { data?: T | null; errors?: GraphQLError[] } | null;
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  if (errors.some(authError)) throw new FeedbackError("upstream_failed", KEY_REJECTED);
  if (errors.some(forbiddenError)) throw new FeedbackError("upstream_failed", KEY_FORBIDDEN);
  if (errors.some(notFoundError)) throw new LinearNotFound("not found");
  if (!response.ok) throw new FeedbackError("upstream_failed", "Linear is not answering. Your draft is saved, so try again.");
  if (errors.length || !body?.data) {
    throw new FeedbackError("upstream_failed", "Linear refused the request. Your draft is saved, so try again.");
  }
  return body.data;
}

/** The receipt line in the description: a hash of the capture, so a retry recognises its own issue. */
export function receiptMarker(metadata: CaptureMetadata, assets: CaptureAsset[]): string {
  const hash = createHash("sha256").update(JSON.stringify(metadata));
  for (const a of assets) hash.update(a.name).update(a.type).update(createHash("sha256").update(a.bytes).digest());
  return `Capture receipt: feedback-widget/${hash.digest("hex")}`;
}

export interface Delivered {
  identifier: string;
  url: string;
}

/** The issue that already has this capture's id: ours (its receipt), or a conflict when it is someone else's. */
async function existing(access: LinearAccess, id: string, marker: string): Promise<Delivered | null> {
  const result = await query<{ issues: { nodes: Issue[] } }>(
    access,
    "query ExistingCapture($id: ID!) { issues(filter: { id: { eq: $id } }, first: 1) { nodes { identifier url description } } }",
    { id },
  );
  const issue = result.issues?.nodes?.[0];
  if (!issue) return null;
  if (!(issue.description ?? "").includes(marker)) {
    throw new FeedbackError("conflict", "This capture id already belongs to a different issue. Discard the draft and start again.");
  }
  return { identifier: issue.identifier, url: issue.url };
}

/** The state (and the project, when there is one) must belong to the team; otherwise nothing is created. */
async function validateDestination(access: LinearAccess, destination: LinearDestination): Promise<void> {
  type Result = {
    workflowState: { team: { id: string } } | null;
    project?: { teams: { nodes: Array<{ id: string }> } } | null;
  };
  let result: Result;
  try {
    result = destination.projectId
      ? await query<Result>(
          access,
          "query Destination($state: String!, $project: String!) { workflowState(id: $state) { team { id } } project(id: $project) { teams { nodes { id } } } }",
          { state: destination.stateId, project: destination.projectId },
        )
      : await query<Result>(access, "query Destination($state: String!) { workflowState(id: $state) { team { id } } }", {
          state: destination.stateId,
        });
  } catch (e) {
    if (e instanceof LinearNotFound) {
      throw new FeedbackError("upstream_failed", `Linear cannot find the ${destination.name} destination for this key.`);
    }
    throw e;
  }
  const stateOk = result.workflowState?.team?.id === destination.teamId;
  const projectOk = !destination.projectId || (result.project?.teams?.nodes ?? []).some((t) => t.id === destination.teamId);
  if (!stateOk || !projectOk) {
    throw new FeedbackError("upstream_failed", `The ${destination.name} destination does not belong to its team, so nothing was sent.`);
  }
}

async function upload(access: LinearAccess, asset: CaptureAsset): Promise<string> {
  const result = await query<{
    fileUpload: { success: boolean; uploadFile: { uploadUrl: string; assetUrl: string; headers: Array<{ key: string; value: string }> } | null };
  }>(
    access,
    "mutation UploadCapture($type: String!, $name: String!, $size: Int!) { fileUpload(contentType: $type, filename: $name, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } } }",
    { type: asset.type, name: asset.name, size: asset.bytes.length },
  );
  const file = result.fileUpload?.uploadFile;
  if (!result.fileUpload?.success || !file) {
    throw new FeedbackError("upstream_failed", "Linear could not take the capture's files. Your draft is saved, so try again.");
  }
  const headers = new Headers({ "Content-Type": asset.type, "Cache-Control": "public, max-age=31536000" });
  for (const { key, value } of file.headers ?? []) headers.set(key, value);
  let response: Response;
  try {
    response = await fetch(file.uploadUrl, {
      method: "PUT",
      headers,
      body: new Uint8Array(asset.bytes),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new FeedbackError("upstream_failed", "A file did not upload to Linear. Your draft is saved, so try again.");
  }
  if (!response.ok) throw new FeedbackError("upstream_failed", "A file did not upload to Linear. Your draft is saved, so try again.");
  return file.assetUrl;
}

function fence(value: unknown): string {
  return "```json\n" + JSON.stringify(value, null, 2).replaceAll("```", "\\u0060\\u0060\\u0060") + "\n```";
}

/** The issue's description: the note, the evidence, who sent it, the capture context, the marker, the footer. */
export function issueDescription(
  metadata: CaptureMetadata,
  server: CaptureContext,
  evidence: string[],
  marker: string,
  footer: string | undefined,
): string {
  const reporter = server.reporter;
  const who = reporter ? [reporter.name, reporter.email].filter(Boolean).join(", ") || reporter.id : undefined;
  const details = {
    page: metadata.page,
    viewport: metadata.viewport,
    target: metadata.target,
    recordingScope: metadata.recordingScope,
    capturedAt: metadata.capturedAt,
    ...(reporter ? { reporter } : {}),
    ...(server.context && Object.keys(server.context).length ? { context: server.context } : {}),
  };
  return [
    metadata.note.trim(),
    ...evidence,
    ...(who ? [`Sent by ${who}`] : []),
    "Capture context",
    fence(details),
    marker,
    ...(footer ? [footer] : []),
  ].join("\n\n");
}

export interface SendOptions {
  access: LinearAccess;
  product: string;
  destination: LinearDestination;
  footer?: string;
  journal: AssetJournal;
}

/**
 * Sends one capture: its existing issue if there is one; else the destination check, the files (each once, through
 * the journal), and the issue with the capture's id. A create that fails or loses its answer looks the id up again.
 */
export async function sendCapture(
  metadata: CaptureMetadata,
  server: CaptureContext,
  assets: CaptureAsset[],
  opts: SendOptions,
): Promise<Delivered> {
  const { access, destination } = opts;
  const marker = receiptMarker(metadata, assets);
  const prior = await existing(access, metadata.id, marker);
  if (prior) return prior;
  await validateDestination(access, destination);
  const evidence: string[] = [];
  for (const asset of assets) {
    let url = opts.journal.cached[asset.name];
    if (!url) {
      url = await upload(access, asset);
      opts.journal.cached[asset.name] = url;
      opts.journal.remember(asset.name, url);
    }
    evidence.push(
      asset.type === "image/png"
        ? `![Element image (DOM render)](${url})`
        : `[Screen recording (${metadata.recordingScope === "element" ? "selected element" : "shared tab or window"})](${url})`,
    );
  }
  try {
    const result = await query<{ issueCreate: { success: boolean; issue: Issue | null } }>(
      access,
      "mutation CreateCapture($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url description } } }",
      {
        input: {
          id: metadata.id,
          teamId: destination.teamId,
          stateId: destination.stateId,
          ...(destination.projectId ? { projectId: destination.projectId } : {}),
          ...(destination.labelIds?.length ? { labelIds: destination.labelIds } : {}),
          title: issueTitle(opts.product, metadata.note),
          description: issueDescription(metadata, server, evidence, marker, opts.footer),
        },
      },
    );
    if (!result.issueCreate?.success || !result.issueCreate.issue) {
      throw new FeedbackError("upstream_failed", "Linear did not confirm the issue. Your draft is saved, so try again.");
    }
    return { identifier: result.issueCreate.issue.identifier, url: result.issueCreate.issue.url };
  } catch (cause) {
    if (cause instanceof FeedbackError && (cause.message === KEY_REJECTED || cause.message === KEY_FORBIDDEN)) throw cause;
    const recovered = await existing(access, metadata.id, marker).catch(() => null);
    if (recovered) return recovered;
    if (cause instanceof LinearNotFound) {
      throw new FeedbackError("upstream_failed", "Linear refused the request. Your draft is saved, so try again.");
    }
    throw cause;
  }
}
