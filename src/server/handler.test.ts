/**
 * The handler at its real boundaries: a Request as a framework passes it, and Linear stubbed at `fetch`, so no test
 * reaches the real Linear. Covers the guard (origin, the site's authorize, caps, strict manifest, destination not
 * settable), delivery idempotency (retry and lost response give the same issue; journalled files are not uploaded
 * twice), the key header, 401/403 reasons, 503 without the key, and the key in no response and no log.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkManifest, issueTitle, MAX_ASSET_BYTES, type CaptureManifest } from "../contract";
import type { Authorization, FeedbackServerConfig } from "./config";
import { LINEAR_GRAPHQL_URL, linearUrl } from "./config";
import { createFeedbackHandler, type FeedbackHandler } from "./handler";
import { KEY_FORBIDDEN, KEY_REJECTED } from "./linear";

const KEY = "lin_api_SYNTHETIC_feedback_key_0123456789";
const ORIGIN = "http://localhost:3161";
const STUB_URL = "http://127.0.0.1:65530/graphql";
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), randomBytes(64)]);
const WEBM = Buffer.concat([Buffer.from("1a45dfa3", "hex"), randomBytes(64)]);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const DESTINATION = { name: "ASC Backlog", teamId: "team-asc", stateId: "state-backlog", labelIds: ["label-feedback"] };

// ---------- the stubbed Linear ----------

interface StubIssue {
  id: string;
  identifier: string;
  description: string;
}

interface Call {
  url: string;
  method: string;
  op: string | null;
  auth: string | null;
  variables: Record<string, unknown> | null;
}

function stubLinear() {
  const issues = new Map<string, StubIssue>();
  const uploads: { name: string; bytes: number }[] = [];
  const calls: Call[] = [];
  const plan: {
    status?: number;
    errors?: { message: string; extensions?: Record<string, string> }[];
    createLosesAnswer?: boolean;
    createFailsOnce?: boolean;
    stateTeam?: string;
    stateType?: string;
    projectTeam?: string;
  } = {};
  let n = 0;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    if ((init?.method ?? "GET") === "PUT") {
      const body = init?.body as Uint8Array;
      uploads.push({ name: url.split("/").pop() ?? "", bytes: body.byteLength });
      calls.push({ url, method: "PUT", op: null, auth: headers.get("authorization"), variables: null });
      return new Response(null, { status: 200 });
    }
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? null;
    calls.push({ url, method: "POST", op, auth: headers.get("authorization"), variables });
    if (plan.status) return json({ errors: [{ message: "stub status" }] }, plan.status);
    if (plan.errors) return json({ data: null, errors: plan.errors });
    switch (op) {
      case "ExistingCapture": {
        const issue = issues.get(String(variables.id));
        return json({ data: { issues: { nodes: issue ? [{ identifier: issue.identifier, url: `https://linear.app/x/issue/${issue.identifier}`, description: issue.description }] : [] } } });
      }
      case "Destination":
        return json({
          data: {
            workflowState: { type: plan.stateType ?? "triage", team: { id: plan.stateTeam ?? DESTINATION.teamId } },
            ...("project" in variables ? { project: { teams: { nodes: [{ id: plan.projectTeam ?? DESTINATION.teamId }] } } } : {}),
          },
        });
      case "UploadCapture": {
        const name = String(variables.name);
        return json({
          data: {
            fileUpload: {
              success: true,
              uploadFile: { uploadUrl: `http://127.0.0.1:65530/upload/${name}`, assetUrl: `https://uploads.linear.app/stub/${name}`, headers: [{ key: "x-stub", value: "1" }] },
            },
          },
        });
      }
      case "CreateCapture": {
        const input = variables.input as { id: string; description: string };
        if (plan.createFailsOnce) {
          plan.createFailsOnce = false;
          return json({ errors: [{ message: "Internal error" }] }, 500);
        }
        if (issues.has(input.id)) return json({ data: null, errors: [{ message: "id taken" }] });
        const issue = { ...input, identifier: `ASC-${900 + ++n}` };
        issues.set(input.id, issue);
        if (plan.createLosesAnswer) {
          plan.createLosesAnswer = false;
          throw new TypeError("fetch failed");
        }
        return json({ data: { issueCreate: { success: true, issue: { identifier: issue.identifier, url: `https://linear.app/x/issue/${issue.identifier}`, description: issue.description } } } });
      }
      default:
        return json({ errors: [{ message: `unknown operation ${op}` }] }, 400);
    }
  });
  return { fetch, issues, uploads, calls, plan, ops: () => calls.map((c) => c.op ?? "PUT") };
}

// ---------- requests ----------

function manifestFor(o: { id?: string; image?: Buffer | null; recording?: Buffer | null; note?: string } = {}): CaptureManifest {
  const image = o.image === undefined ? PNG : o.image;
  const recording = o.recording ?? null;
  return {
    metadata: {
      id: o.id ?? randomUUID(),
      note: o.note ?? "The Continue button needs a clearer label.\nIt reads like it skips the lesson.",
      page: "/climb/c-a0?step=2",
      capturedAt: "2026-11-15T09:30:00.000Z",
      viewport: { width: 1440, height: 900 },
      target: { selector: "#continue", tag: "button", text: "Continue", rect: { x: 10, y: 20, width: 90, height: 30 } },
      recordingScope: recording ? "element" : null,
    },
    assets: [
      ...(image ? [{ kind: "image" as const, type: "image/png" as const, size: image.length, sha256: sha(image) }] : []),
      ...(recording ? [{ kind: "recording" as const, type: "video/webm" as const, size: recording.length, sha256: sha(recording) }] : []),
    ],
  };
}

async function capture(
  manifest: unknown,
  files: { image?: Buffer; recording?: Buffer; extra?: Record<string, string | Blob> } = {},
  headers: Record<string, string> = {},
): Promise<Request> {
  const form = new FormData();
  form.append("manifest", typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  if (files.image) form.append("image", new Blob([new Uint8Array(files.image)], { type: "image/png" }));
  if (files.recording) form.append("recording", new Blob([new Uint8Array(files.recording)], { type: "video/webm" }));
  for (const [k, v] of Object.entries(files.extra ?? {})) form.append(k, v);
  const r = new Response(form);
  const body = await r.arrayBuffer();
  const all: Record<string, string> = {
    host: "localhost:3161",
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "content-type": r.headers.get("content-type")!,
    "content-length": String(body.byteLength),
    ...headers,
  };
  for (const [k, v] of Object.entries(all)) if (v === "") delete all[k];
  return new Request(`${ORIGIN}/api/feedback`, { method: "POST", headers: all, body });
}

// ---------- setup ----------

let linear: ReturnType<typeof stubLinear>;
let logs: unknown[][];
let auth: Authorization;
let key: string | undefined;
let POST: FeedbackHandler;
let errors: { kind: string; code: string }[];

const config = (): FeedbackServerConfig => ({
  product: "The Ascent",
  linearApiKey: key,
  linearApiUrl: STUB_URL,
  destination: DESTINATION,
  authorize: () => auth,
  receiptUrl: ({ identifier }) => `https://gateway.example/l/${identifier}`,
  footer: "Owner feedback; do not start an agent.",
  onError: (e) => errors.push(e),
});

const send = async (m: CaptureManifest, files: { image?: Buffer; recording?: Buffer } = { image: PNG }) => POST(await capture(m, files));
const errorOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;

beforeEach(() => {
  linear = stubLinear();
  vi.stubGlobal("fetch", linear.fetch);
  logs = [];
  errors = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args));
  }
  auth = { ok: true, reporter: { id: "user-1", name: "Philip", email: "philip@example.com" }, context: { role: "owner" } };
  key = KEY;
  POST = createFeedbackHandler(config);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------- the guard ----------

describe("the guard", () => {
  it("refuses a cross-site write, a foreign origin and a missing origin before calling Linear", async () => {
    const m = manifestFor();
    const cross = await POST(await capture(m, { image: PNG }, { "sec-fetch-site": "cross-site" }));
    expect(cross.status).toBe(403);
    expect((await POST(await capture(m, { image: PNG }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await POST(await capture(m, { image: PNG }, { origin: "" }))).status).toBe(403);
    expect(linear.fetch).not.toHaveBeenCalled();
  });

  it("accepts the origin of a forwarded host (a proxy in front) and a configured extra origin", async () => {
    const proxied = await POST(await capture(manifestFor(), { image: PNG }, { host: "internal:8080", "x-forwarded-host": "app.example.com", origin: "https://app.example.com" }));
    expect(proxied.status).toBe(200);
    const extra = createFeedbackHandler(() => ({ ...config(), allowedOrigins: ["https://other.example"] }));
    expect((await extra(await capture(manifestFor(), { image: PNG }, { origin: "https://other.example" }))).status).toBe(200);
  });

  it("asks the site's authorize and answers its refusal: 401, 403 or 404, calling nothing", async () => {
    for (const [status, code] of [
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not_found"],
    ] as const) {
      auth = { ok: false, status };
      const r = await send(manifestFor());
      expect(r.status).toBe(status);
      expect((await errorOf(r)).code).toBe(code);
    }
    expect(linear.fetch).not.toHaveBeenCalled();
  });

  it("takes multipart only", async () => {
    const r = await POST(
      new Request(`${ORIGIN}/api/feedback`, { method: "POST", headers: { host: "localhost:3161", origin: ORIGIN, "content-type": "application/json", "content-length": "2" }, body: "{}" }),
    );
    expect(r.status).toBe(415);
  });

  it("refuses an oversize body by its Content-Length, by the bytes actually read, a manifest over 32 KB and a file over 12 MB", async () => {
    const m = manifestFor();
    expect((await POST(await capture(m, { image: PNG }, { "content-length": String(30 * 1024 * 1024) }))).status).toBe(413);
    const huge = Buffer.alloc(25 * 1024 * 1024, 1);
    const lying = await POST(
      new Request(`${ORIGIN}/api/feedback`, { method: "POST", headers: { host: "localhost:3161", origin: ORIGIN, "content-type": "multipart/form-data; boundary=x", "content-length": "100" }, body: huge }),
    );
    expect(lying.status).toBe(413);
    expect((await POST(await capture(JSON.stringify({ ...m, pad: "x".repeat(40 * 1024) }), { image: PNG }))).status).toBe(413);
    const bigImage = Buffer.concat([PNG, Buffer.alloc(MAX_ASSET_BYTES)]);
    expect((await POST(await capture(manifestFor({ image: PNG }), { image: bigImage }))).status).toBe(413);
    expect(linear.fetch).not.toHaveBeenCalled();
  });

  it("refuses a bad manifest: not JSON, an empty note, a bad id, an image without its element, files that do not match", async () => {
    expect((await POST(await capture("{nope", { image: PNG }))).status).toBe(400);
    const m = manifestFor();
    expect((await POST(await capture({ ...m, metadata: { ...m.metadata, note: "   " } }, { image: PNG }))).status).toBe(400);
    expect((await POST(await capture({ ...m, metadata: { ...m.metadata, id: "../../etc/passwd" } }, { image: PNG }))).status).toBe(400);
    expect((await POST(await capture({ ...m, metadata: { ...m.metadata, target: null } }, { image: PNG }))).status).toBe(400);
    expect((await POST(await capture(manifestFor({ image: null }), { image: PNG }))).status).toBe(400);
    const changed = await POST(await capture(m, { image: Buffer.concat([PNG, Buffer.from("x")]) }));
    expect(changed.status).toBe(400);
    expect((await errorOf(changed)).message).toMatch(/incomplete or changed/);
    expect(linear.fetch).not.toHaveBeenCalled();
  });

  it("never lets the browser choose the destination: a team, project, state or label field anywhere is refused", async () => {
    const m = manifestFor();
    for (const bad of [
      { ...m, projectId: "other" },
      { ...m, metadata: { ...m.metadata, teamId: "other" } },
      { ...m, metadata: { ...m.metadata, stateId: "other" } },
      { ...m, metadata: { ...m.metadata, labelIds: ["other"] } },
      { ...m, assets: m.assets.map((a) => ({ ...a, url: "https://elsewhere" })) },
    ]) {
      const r = await POST(await capture(bad, { image: PNG }));
      expect(r.status).toBe(400);
      expect((await errorOf(r)).message).toMatch(/unknown field/);
    }
    expect((await POST(await capture(m, { image: PNG, extra: { projectId: "other" } }))).status).toBe(400);
    expect(linear.fetch).not.toHaveBeenCalled();
    expect((await send(manifestFor())).status).toBe(200);
    const input = linear.calls.find((c) => c.op === "CreateCapture")!.variables!.input as Record<string, unknown>;
    expect([input.teamId, input.stateId, input.labelIds, "projectId" in input]).toEqual([DESTINATION.teamId, DESTINATION.stateId, DESTINATION.labelIds, false]);
  });
});

// ---------- the key ----------

describe("the Linear key", () => {
  it("goes in the Authorization header as it is on every GraphQL call, and never to the upload URL", async () => {
    expect((await send(manifestFor())).status).toBe(200);
    const graphql = linear.calls.filter((c) => c.method === "POST");
    expect(graphql.length).toBeGreaterThan(0);
    for (const c of graphql) {
      expect(c.auth).toBe(KEY);
      expect(c.url).toBe(STUB_URL);
    }
    for (const c of linear.calls.filter((c) => c.method === "PUT")) expect(c.auth).toBeNull();
  });

  it("answers 503 not_configured, and calls nothing, when the key is absent", async () => {
    key = undefined;
    const r = await send(manifestFor());
    expect(r.status).toBe(503);
    expect((await errorOf(r)).code).toBe("not_configured");
    expect(linear.fetch).not.toHaveBeenCalled();
  });

  it("a 401 or an authentication error answers KEY_REJECTED; a 403 or permission error KEY_FORBIDDEN", async () => {
    linear.plan.status = 401;
    expect((await errorOf(await send(manifestFor()))).message).toBe(KEY_REJECTED);
    linear.plan.status = undefined;
    linear.plan.errors = [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR", type: "authentication error" } }];
    expect((await errorOf(await send(manifestFor()))).message).toBe(KEY_REJECTED);
    linear.plan.errors = undefined;
    linear.plan.status = 403;
    expect((await errorOf(await send(manifestFor()))).message).toBe(KEY_FORBIDDEN);
    linear.plan.status = undefined;
    linear.plan.errors = [{ message: "You don't have permission to access this team", extensions: { code: "FORBIDDEN", type: "forbidden" } }];
    expect((await errorOf(await send(manifestFor()))).message).toBe(KEY_FORBIDDEN);
  });

  it("never appears in a response, a log or an onError event, whatever happens", async () => {
    const bodies: string[] = [];
    const record = async (r: Response) => bodies.push(JSON.stringify([...r.headers]) + (await r.text()));
    await record(await send(manifestFor()));
    linear.plan.status = 401;
    await record(await send(manifestFor()));
    linear.plan.status = undefined;
    linear.fetch.mockImplementationOnce(async () => {
      throw new RangeError(`boom ${KEY}`);
    });
    await record(await send(manifestFor()));
    linear.fetch.mockImplementationOnce(async () => new Response("<html>", { status: 200 }));
    await record(await send(manifestFor()));
    expect(bodies.length).toBe(4);
    for (const b of bodies) expect(b).not.toContain(KEY);
    expect(JSON.stringify(logs)).not.toContain(KEY);
    expect(JSON.stringify(errors)).not.toContain(KEY);
  });

  it("is sent to Linear or the loopback only: an override naming another host is ignored", () => {
    expect(linearUrl(undefined)).toBe(LINEAR_GRAPHQL_URL);
    expect(linearUrl("http://127.0.0.1:4100/graphql")).toBe("http://127.0.0.1:4100/graphql");
    expect(linearUrl("https://evil.example/graphql")).toBe(LINEAR_GRAPHQL_URL);
    expect(linearUrl("http://127.0.0.1.evil.example/graphql")).toBe(LINEAR_GRAPHQL_URL);
  });
});

// ---------- delivery ----------

describe("delivery: one capture, one issue", () => {
  it("creates the issue: id, title, note, evidence, reporter, capture context, footer, the site's receipt link", async () => {
    const m = manifestFor({ recording: WEBM });
    const r = await send(m, { image: PNG, recording: WEBM });
    expect(r.status).toBe(200);
    const receipt = (await r.json()) as { identifier: string; url: string };
    expect(receipt.identifier).toMatch(/^ASC-\d+$/);
    expect(receipt.url).toBe(`https://gateway.example/l/${receipt.identifier}`);
    const input = linear.calls.find((c) => c.op === "CreateCapture")!.variables!.input as Record<string, string>;
    expect(input.id).toBe(m.metadata.id);
    expect(input.title).toBe("[The Ascent] The Continue button needs a clearer label.");
    const d = input.description!;
    expect(d.startsWith(m.metadata.note)).toBe(true);
    expect(d).toContain("![Element image (DOM render)](https://uploads.linear.app/stub/element.png)");
    expect(d).toContain("[Screen recording (selected element)](https://uploads.linear.app/stub/recording.webm)");
    expect(d).toContain("Sent by Philip, philip@example.com");
    const context = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(d)![1]!);
    expect(context).toEqual({
      page: "/climb/c-a0?step=2",
      viewport: { width: 1440, height: 900 },
      target: m.metadata.target,
      recordingScope: "element",
      capturedAt: "2026-11-15T09:30:00.000Z",
      reporter: { id: "user-1", name: "Philip", email: "philip@example.com" },
      context: { role: "owner" },
    });
    expect(d.endsWith("Owner feedback; do not start an agent.")).toBe(true);
    expect(linear.uploads.map((u) => u.name)).toEqual(["element.png", "recording.webm"]);
  });

  it("text only: no files, no element, one issue", async () => {
    const m = manifestFor({ image: null });
    const r = await POST(await capture({ ...m, metadata: { ...m.metadata, target: null } }));
    expect(r.status).toBe(200);
    expect(linear.uploads.length).toBe(0);
  });

  it("checks the destination first: a state or project of another team creates nothing", async () => {
    linear.plan.stateTeam = "another-team";
    const r = await send(manifestFor());
    expect(r.status).toBe(502);
    expect((await errorOf(r)).message).toMatch(/does not belong to its team/);
    linear.plan.stateTeam = undefined;
    linear.plan.projectTeam = "another-team";
    const withProject = createFeedbackHandler(() => ({ ...config(), destination: { ...DESTINATION, projectId: "project-1" } }));
    expect((await withProject(await capture(manifestFor(), { image: PNG }))).status).toBe(502);
    expect(linear.ops()).not.toContain("UploadCapture");
    expect(linear.ops()).not.toContain("CreateCapture");
  });

  it("a destination that names its state type refuses a state of another type, and sends to the right one", async () => {
    const triageOnly = createFeedbackHandler(() => ({ ...config(), destination: { ...DESTINATION, stateType: "triage" } }));
    linear.plan.stateType = "backlog";
    const wrong = await triageOnly(await capture(manifestFor(), { image: PNG }));
    expect(wrong.status).toBe(502);
    expect((await errorOf(wrong)).message).toMatch(/is not a triage state/);
    expect(linear.ops()).not.toContain("CreateCapture");
    linear.plan.stateType = "triage";
    expect((await triageOnly(await capture(manifestFor(), { image: PNG }))).status).toBe(200);
  });

  it("a retry of a sent capture answers the same receipt without asking Linear again", async () => {
    const m = manifestFor();
    const first = await (await send(m)).json();
    const calls = linear.calls.length;
    const again = await send(m);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    expect(linear.calls.length).toBe(calls);
    expect(linear.issues.size).toBe(1);
  });

  it("a lost response from Linear: the capture's id finds the issue, once", async () => {
    linear.plan.createLosesAnswer = true;
    const m = manifestFor();
    const r = await send(m);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { identifier: string }).identifier).toBe(linear.issues.get(m.metadata.id)!.identifier);
    expect(linear.issues.size).toBe(1);
  });

  it("a restarted server (no memory of the send): the retry finds the issue by id and creates nothing", async () => {
    const m = manifestFor();
    const first = (await (await send(m)).json()) as { identifier: string };
    POST = createFeedbackHandler(config);
    const creates = linear.ops().filter((o) => o === "CreateCapture").length;
    const again = (await (await send(m)).json()) as { identifier: string };
    expect(again.identifier).toBe(first.identifier);
    expect(linear.ops().filter((o) => o === "CreateCapture").length).toBe(creates);
    expect(linear.issues.size).toBe(1);
  });

  it("journalled files are not uploaded twice: a create that failed, then a retry, uploads each file once", async () => {
    linear.plan.createFailsOnce = true;
    const m = manifestFor({ recording: WEBM });
    expect((await send(m, { image: PNG, recording: WEBM })).status).toBe(502);
    expect(linear.uploads.length).toBe(2);
    expect((await send(m, { image: PNG, recording: WEBM })).status).toBe(200);
    expect(linear.uploads.length).toBe(2);
    expect(linear.issues.size).toBe(1);
  });

  it("the same id with different content is refused (409), not sent as a second issue", async () => {
    const m = manifestFor();
    await send(m);
    const r = await send({ ...m, metadata: { ...m.metadata, note: "Something else entirely" } });
    expect(r.status).toBe(409);
    expect(linear.issues.size).toBe(1);
  });
});

describe("the contract", () => {
  it("titles the issue with the product and the note's first line, cut to about 80 characters", () => {
    expect(issueTitle("Nudge", "Short note\nmore")).toBe("[Nudge] Short note");
    const long = issueTitle("Nudge", "word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual("[Nudge] ".length + 83);
    expect(long.endsWith("...")).toBe(true);
  });

  it("refuses two images and a recording without its scope", () => {
    const m = manifestFor();
    expect(checkManifest({ ...m, assets: [m.assets[0], m.assets[0]] }).ok).toBe(false);
    expect(checkManifest({ ...m, assets: [...m.assets, { kind: "recording", type: "video/webm", size: 5, sha256: "a".repeat(64) }] }).ok).toBe(false);
    expect(checkManifest(m).ok).toBe(true);
  });
});
