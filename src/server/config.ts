/**
 * What a site configures on the server. The browser can never choose any of it: the manifest check refuses unknown
 * keys, and everything that decides who may send or where an issue lands lives here.
 */

export interface Reporter {
  id?: string;
  name?: string;
  email?: string;
}

/** A site's answer to "may this request send feedback?". */
export type Authorization =
  | {
      ok: true;
      /** Who sent it, as the site knows them. Written into the issue. */
      reporter?: Reporter;
      /** Extra server-side context for the issue (organisation, role, build). Never taken from the browser. */
      context?: Record<string, unknown>;
    }
  | {
      ok: false;
      /** 401 not signed in; 403 signed in but not allowed; 404 to hide that the endpoint exists. */
      status: 401 | 403 | 404;
      message?: string;
    };

export interface LinearDestination {
  /** Shown in errors and logs, e.g. "ASC Backlog". */
  name: string;
  teamId: string;
  /** The workflow state new issues take. It must belong to the team. */
  stateId: string;
  /**
   * Optional: the type the state must have ("triage", "backlog", "unstarted", ...), checked before every send, so a
   * renamed or reused state id cannot quietly file issues somewhere else.
   */
  stateType?: string;
  /** Optional project; it must belong to the team. */
  projectId?: string;
  /** Optional labels (team or workspace labels). */
  labelIds?: string[];
}

export interface FeedbackServerConfig {
  /** The product name: the issue title prefix, e.g. "The Ascent" gives "[The Ascent] ...". */
  product: string;
  /** The Linear API key (a personal key or an OAuth token string as Linear accepts it). Missing means 503. */
  linearApiKey: string | null | undefined;
  /** Tests and local stand-ins only: honoured only for an http loopback URL, so the key never leaves for elsewhere. */
  linearApiUrl?: string;
  destination: LinearDestination;
  /** The site's access check. Runs before the body is read. */
  authorize: (request: Request) => Authorization | Promise<Authorization>;
  /** The link the receipt shows. Defaults to Linear's own issue URL. */
  receiptUrl?: (issue: { identifier: string; url: string }) => string;
  /** The last line of every issue. */
  footer?: string;
  /**
   * Origins (scheme://host[:port]) allowed besides the request's own host. The handler refuses cross-site requests
   * and an Origin that names another host.
   */
  allowedOrigins?: string[];
  /** Called with a failure's class only: never the key, a URL, the note or a provider body. */
  onError?: (event: { kind: string; code: string }) => void;
}

export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function linearUrl(override: string | undefined): string {
  if (!override) return LINEAR_GRAPHQL_URL;
  try {
    const u = new URL(override);
    if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return u.href;
  } catch {
    // not a URL: Linear's own
  }
  return LINEAR_GRAPHQL_URL;
}
