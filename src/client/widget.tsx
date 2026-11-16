/**
 * <FeedbackWidget>: the one component a site mounts, with its configuration. Render it only for people who may send
 * feedback; the site's server route checks again. The panel and html-to-image load on first open, so a page's first
 * load carries only the launcher.
 */

import { Component, lazy, Suspense, useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";

import type { CaptureReceipt } from "../contract";
import type { SubmitCapture } from "./submit";
import { closeFeedback, registerWidget, toggleFeedback, useFeedbackOpen } from "./state";
import { Button, Icon } from "./ui";

// A fresh lazy component per attempt: React caches a failed import, so Try again needs a new one.
const loadPanel = () => lazy(() => import("./panel").then((m) => ({ default: m.FeedbackPanel })));

/**
 * Keeps a failed panel download (offline, a deploy that removed the old chunk) inside the widget: a short message
 * with Try again, never an error that reaches the host page's error boundary.
 */
class PanelBoundary extends Component<{ open: boolean; onRetry: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    if (!this.props.open) return null;
    return (
      <section className="fbw-panel fbw-load-failed" role="alert" data-testid="feedback-load-failed">
        <p>Feedback could not load. Check your connection, then try again.</p>
        <div className="fbw-row">
          <Button
            size="sm"
            variant="primary"
            data-testid="feedback-load-retry"
            onClick={() => {
              this.setState({ failed: false });
              this.props.onRetry();
            }}
          >
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={() => closeFeedback()}>
            Close
          </Button>
        </div>
      </section>
    );
  }
}

export interface FeedbackWidgetProps {
  /** The site's feedback route, e.g. "/api/feedback". */
  endpoint: string;
  /** Where issues go, as the panel says it: "Goes to {destinationLabel}." e.g. "The Ascent backlog in Linear". */
  destinationLabel: string;
  /**
   * Scopes local drafts. Include the signed-in person's id, so one person's draft is never restored for another on a
   * shared browser, e.g. `ascent:${userId}`.
   */
  draftScope: string;
  /** "floating" (default) shows a launcher at the bottom right; "none" leaves the entry point to the site (openFeedback()). */
  launcher?: "floating" | "none";
  launcherLabel?: string;
  /** Cmd/Ctrl+Shift+F opens and closes the panel. Default true. */
  shortcut?: boolean;
  title?: string;
  /** Called with the receipt after a successful send, e.g. for the site's own toast. */
  onSent?: (receipt: CaptureReceipt) => void;
  /**
   * How a sealed draft reaches the server. Default: one multipart POST to `endpoint` (createFeedbackHandler). A site
   * whose host caps request bodies (Vercel: 4.5 MB) passes its own, e.g. upload the files to storage, then ask its
   * route to deliver them with sendCapture from "@bubblesorted/feedback-widget/server". Build the manifest with
   * buildManifest, and throw an Error whose message the panel can show; the draft stays saved for Retry.
   */
  submit?: SubmitCapture;
  /** Extra class on the root, for theming through the --fbw-* variables. */
  className?: string;
  style?: CSSProperties;
}

function isMac(): boolean {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad/i.test(platform);
}

export function FeedbackWidget({
  endpoint,
  destinationLabel,
  draftScope,
  launcher = "floating",
  launcherLabel = "Feedback",
  shortcut = true,
  title = "Send feedback",
  onSent,
  submit,
  className,
  style,
}: FeedbackWidgetProps) {
  const open = useFeedbackOpen();
  const [loaded, setLoaded] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const [shortcutLabel, setShortcutLabel] = useState<string | null>(null);
  const [Panel, setPanel] = useState(loadPanel);

  useEffect(() => registerWidget(), []);

  useEffect(() => {
    if (open) setLoaded(true);
  }, [open]);

  useEffect(() => {
    if (!shortcut) {
      setShortcutLabel(null);
      return;
    }
    setShortcutLabel(isMac() ? "⌘⇧F" : "Ctrl+Shift+F");
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "KeyF" || !event.shiftKey || event.altKey || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      toggleFeedback();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcut]);

  const onBusyOverlay = useCallback((busy: boolean) => setOverlay(busy), []);

  return (
    <div className={["fbw-root", className].filter(Boolean).join(" ")} style={style} data-feedback-capture="root">
      {launcher === "floating" && !overlay ? (
        <button
          type="button"
          className="fbw-launcher"
          aria-expanded={open}
          aria-haspopup="dialog"
          data-open={open ? "" : undefined}
          data-testid="feedback-launcher"
          onClick={() => toggleFeedback()}
        >
          <Icon name="message" size={16} />
          <span>{launcherLabel}</span>
        </button>
      ) : null}
      {loaded ? (
        <PanelBoundary open={open} onRetry={() => setPanel(loadPanel)}>
          <Suspense fallback={null}>
            <Panel
              endpoint={endpoint}
              submit={submit}
              draftScope={draftScope}
              destinationLabel={destinationLabel}
              title={title}
              shortcutLabel={shortcutLabel}
              onSent={onSent}
              onBusyOverlay={onBusyOverlay}
            />
          </Suspense>
        </PanelBoundary>
      ) : null}
    </div>
  );
}
