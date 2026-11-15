/**
 * The panel. Loaded on first open and kept mounted after, so a draft, a pick or a recording survives the panel
 * closing. One primary action, Send.
 *
 * Keys: Esc cancels the picker first (its own listener), then closes the panel. The panel is a non-modal dialog.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { DRAFT_TTL_MS, MAX_ASSET_BYTES, MAX_NOTE_CHARS, MAX_RECORDING_MS, type CaptureDraft, type CaptureReceipt, type RecordingScope } from "../contract";
import { openDraftSession } from "./draft-session";
import { readDraft, writeDraft } from "./draft-store";
import { CAPTURE_UI, describeTarget } from "./picker";
import { canCropToElement, canRecord, startRecording, type Recording } from "./recording";
import { closeFeedback, useFeedbackOpen } from "./state";
import { submitCapture } from "./submit";
import { TargetPicker } from "./target-picker";
import { Button, Icon } from "./ui";

export interface PanelProps {
  endpoint: string;
  draftScope: string;
  destinationLabel: string;
  title: string;
  shortcutLabel: string | null;
  onSent?: (receipt: CaptureReceipt) => void;
  /** Called while the picker or the recorder is up, so the launcher can step aside. */
  onBusyOverlay?: (busy: boolean) => void;
}

/**
 * Where the capture is being made: the page and the viewport now. Each piece of evidence (a pick, an image, a
 * recording) stamps it, so the issue's page and viewport are those of the latest evidence, even when the draft was
 * started on another page (a draft lives across navigation).
 */
function here(): Pick<CaptureDraft["metadata"], "page" | "viewport" | "capturedAt"> {
  return {
    page: (location.pathname + location.search).slice(0, 2000),
    viewport: { width: Math.max(1, innerWidth), height: Math.max(1, innerHeight) },
    capturedAt: new Date().toISOString(),
  };
}

function freshDraft(): CaptureDraft {
  return {
    metadata: { id: crypto.randomUUID(), note: "", ...here(), target: null, recordingScope: null },
    sealed: false,
    expiresAt: Date.now() + DRAFT_TTL_MS,
  };
}

export function transparent(color: string): boolean {
  return !color || color === "transparent" || /^rgba\([^)]*,\s*0\)$/.test(color.replace(/\s+/g, " ").trim());
}

/** The first opaque background behind the page: body, then html, then white. */
function pageBackground(): string {
  for (const el of [document.body, document.documentElement]) {
    const bg = getComputedStyle(el).backgroundColor;
    if (!transparent(bg)) return bg;
  }
  return "#ffffff";
}

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong. Your draft is still here.";
}

/** An object URL for a preview, made after commit and revoked when the blob changes or the panel goes. */
function useBlobUrl(blob: Blob | undefined): string | undefined {
  const [entry, setEntry] = useState<{ blob: Blob; url: string }>();
  useEffect(() => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    let live = true;
    void Promise.resolve().then(() => {
      if (live) setEntry({ blob, url });
    });
    return () => {
      live = false;
      URL.revokeObjectURL(url);
    };
  }, [blob]);
  return entry && entry.blob === blob ? entry.url : undefined;
}

export function FeedbackPanel({ endpoint, draftScope, destinationLabel, title, shortcutLabel, onSent, onBusyOverlay }: PanelProps) {
  const open = useFeedbackOpen();
  const [draft, setDraft] = useState<CaptureDraft>();
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<CaptureReceipt>();
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [scope, setScope] = useState<RecordingScope>(() => (canCropToElement() ? "element" : "shared-surface"));
  const [narration, setNarration] = useState(false);
  const [recordable] = useState(canRecord);
  const target = useRef<Element | null>(null);
  const activeRecording = useRef<Recording | undefined>(undefined);
  const lifecycle = useRef(0);
  const panel = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const draftKey = useRef("");
  const imageUrl = useBlobUrl(draft?.image);
  const videoUrl = useBlobUrl(draft?.recording);
  const shown = open && !picking && !recording;

  useEffect(() => {
    onBusyOverlay?.(picking || recording);
  }, [picking, recording, onBusyOverlay]);

  useEffect(() => {
    let live = true;
    const life = lifecycle;
    life.current++;
    const release = openDraftSession(
      draftScope,
      async (key) => {
        draftKey.current = key;
        const saved = await readDraft(key).catch(() => undefined);
        if (live) setDraft(saved ?? freshDraft());
      },
      (cause) => {
        if (live) {
          setError(message(cause));
          setDraft((d) => d ?? freshDraft());
        }
      },
    );
    return () => {
      live = false;
      // A recording started before this cleanup sees the bump and stops (record()).
      life.current++;
      release();
      activeRecording.current?.stop();
    };
  }, [draftScope]);

  useEffect(() => {
    if (!draft || !draftKey.current) return;
    void writeDraft(draftKey.current, draft).catch((cause) => setError(message(cause)));
  }, [draft]);

  // Focus: into the panel when it shows, back where it came from when it closes.
  useEffect(() => {
    if (open && !returnFocus.current) {
      const active = document.activeElement;
      returnFocus.current = active instanceof HTMLElement && !active.closest(CAPTURE_UI) ? active : null;
    }
    if (shown) panel.current?.focus({ preventScroll: true });
    if (!open && returnFocus.current) {
      const back = returnFocus.current;
      returnFocus.current = null;
      if (back.isConnected) back.focus({ preventScroll: true });
    }
  }, [open, shown]);

  // Esc closes the panel (the picker's own capture-phase listener takes Esc first while it is up).
  useEffect(() => {
    if (!shown) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || busy) return;
      event.preventDefault();
      closeFeedback();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [shown, busy]);

  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 250);
    return () => clearInterval(timer);
  }, [recording]);

  const choose = useCallback((element: Element) => {
    target.current = element;
    setDraft(
      (previous) =>
        previous && {
          ...previous,
          image: undefined,
          recording: undefined,
          metadata: { ...previous.metadata, ...here(), target: describeTarget(element), recordingScope: null },
        },
    );
    setPicking(false);
    setError("");
  }, []);
  const cancelPicker = useCallback(() => setPicking(false), []);

  async function captureImage() {
    const element = target.current;
    if (!element?.isConnected || !draft) {
      setError("Pick the element again before capturing it.");
      return;
    }
    setBusy("Capturing the element");
    setError("");
    const where = here();
    // Transitions and animations are off for the length of the capture, so the image shows the element at rest.
    const still = document.createElement("style");
    still.setAttribute("data-feedback-capture", "still");
    still.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
    try {
      const { domToBlob } = await import("modern-screenshot");
      document.head.appendChild(still);
      const image = await domToBlob(element, {
        scale: Math.min(devicePixelRatio || 1, 2),
        // The backgroundColor option is painted onto the captured element itself, over its own background (a green
        // button came out white). Only an element with no background of its own gets the page's.
        backgroundColor: transparent(getComputedStyle(element).backgroundColor) ? pageBackground() : null,
        filter: (node) => !(node instanceof Element && node.matches(CAPTURE_UI)),
        type: "image/png",
      });
      if (!image?.size) throw new Error("The image could not be captured. Try recording the element instead.");
      if (image.size > MAX_ASSET_BYTES) throw new Error("This image is over 12 MB. Pick a smaller element.");
      setDraft((previous) => previous && { ...previous, image, metadata: { ...previous.metadata, ...where, target: describeTarget(element) } });
    } catch (cause) {
      setError(message(cause));
    } finally {
      still.remove();
      setBusy("");
    }
  }

  async function record() {
    if (!draft) return;
    if (scope === "element" && !target.current?.isConnected) {
      setError("Pick an element before recording it.");
      return;
    }
    setBusy("Choose what to share");
    setError("");
    const startedIn = lifecycle.current;
    const where = here();
    try {
      // First, before any other await: the browser wants this user gesture.
      const capture = await startRecording(scope === "element" ? target.current : null, narration);
      if (lifecycle.current !== startedIn) {
        capture.stop();
        await capture.finished.catch(() => {});
        return;
      }
      activeRecording.current = capture;
      setSeconds(0);
      setRecording(true);
      setBusy("");
      const video = await capture.finished;
      setDraft((previous) => previous && { ...previous, recording: video, metadata: { ...previous.metadata, ...where, recordingScope: scope } });
    } catch (cause) {
      setError(message(cause));
    } finally {
      activeRecording.current = undefined;
      setRecording(false);
      setBusy("");
    }
  }

  async function submit() {
    if (!draft || busy) return;
    if (draft.expiresAt <= Date.now()) {
      setError("This draft is more than 24 hours old. Discard it to start again.");
      return;
    }
    setBusy("Sending");
    setError("");
    const sealed = { ...draft, sealed: true, metadata: { ...draft.metadata, note: draft.metadata.note.trim() } };
    setDraft(sealed);
    try {
      await writeDraft(draftKey.current, sealed);
      const r = await submitCapture(endpoint, sealed);
      setReceipt(r);
      onSent?.(r);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy("");
    }
  }

  const discard = () => {
    target.current = null;
    setReceipt(undefined);
    setError("");
    setDraft(freshDraft());
  };

  const locked = Boolean(busy || draft?.sealed);
  const t = draft?.metadata.target ?? null;
  const noteOk = (draft?.metadata.note.trim().length ?? 0) > 0;

  return (
    <>
      {picking ? <TargetPicker onChoose={choose} onCancel={cancelPicker} /> : null}
      {recording ? (
        <div className="fbw-bar" role="status" data-testid="feedback-recording" data-feedback-capture="recording">
          <span className="fbw-dot" aria-hidden="true" />
          <span>
            Recording {seconds}s of {MAX_RECORDING_MS / 1000}s
          </span>
          <Button size="sm" variant="primary" onClick={() => activeRecording.current?.stop()}>
            Stop recording
          </Button>
        </div>
      ) : null}
      {shown ? (
        <section
          ref={panel}
          tabIndex={-1}
          className="fbw-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="fbw-title"
          data-testid="feedback-panel"
        >
          <header className="fbw-head">
            <h2 id="fbw-title">{title}</h2>
            <Button variant="ghost" size="sm" icon="x" label="Close feedback" onClick={() => closeFeedback()} disabled={Boolean(busy)} />
          </header>
          {receipt ? (
            <div className="fbw-done" role="status" data-testid="feedback-receipt">
              <p>
                <Icon name="check" size={16} /> Sent as{" "}
                <a href={receipt.url} target="_blank" rel="noopener noreferrer" data-testid="feedback-receipt-link">
                  {receipt.identifier}
                </a>
                .
              </p>
              <div className="fbw-row">
                <span className="fbw-grow" />
                <Button size="sm" onClick={() => closeFeedback()}>
                  Close
                </Button>
                <Button size="sm" variant="primary" onClick={discard}>
                  New feedback
                </Button>
              </div>
            </div>
          ) : (
            <>
              {t ? (
                <div className="fbw-target" data-testid="feedback-target">
                  <span className="fbw-tag">{t.tag}</span>
                  <span className="fbw-ttext">{t.text || "Selected element"}</span>
                  <Button size="sm" variant="ghost" icon="target" disabled={locked} onClick={() => setPicking(true)}>
                    Change
                  </Button>
                  <code className="fbw-sel" title={t.selector}>
                    {t.selector}
                  </code>
                </div>
              ) : (
                <Button icon="target" className="fbw-pick" disabled={locked || !draft} onClick={() => setPicking(true)} data-testid="feedback-pick">
                  Pick an element
                </Button>
              )}
              <div className="fbw-row">
                <Button size="sm" icon="image" disabled={locked || !t} onClick={() => void captureImage()} data-testid="feedback-capture-image">
                  Capture image
                </Button>
                {recordable ? (
                  <Button size="sm" icon="record" disabled={locked || !draft} onClick={() => void record()} data-testid="feedback-record">
                    Record
                  </Button>
                ) : null}
              </div>
              {recordable ? (
                <div className="fbw-opts">
                  <label>
                    Record
                    <select aria-label="Recording area" value={scope} disabled={locked} onChange={(e) => setScope(e.target.value as RecordingScope)}>
                      {canCropToElement() ? <option value="element">Selected element</option> : null}
                      <option value="shared-surface">Shared tab or window</option>
                    </select>
                  </label>
                  <label>
                    <input type="checkbox" checked={narration} disabled={locked} onChange={(e) => setNarration(e.target.checked)} /> Narrate with the microphone
                  </label>
                </div>
              ) : null}
              {imageUrl || videoUrl ? (
                <div className="fbw-evidence">
                  {imageUrl ? (
                    <figure>
                      <img src={imageUrl} alt="Selected element capture" data-testid="feedback-image" />
                      <figcaption>
                        <span>Element image</span>
                        <Button size="sm" variant="ghost" disabled={locked} onClick={() => setDraft((p) => p && { ...p, image: undefined })}>
                          Remove
                        </Button>
                      </figcaption>
                    </figure>
                  ) : null}
                  {videoUrl ? (
                    <figure>
                      <video src={videoUrl} controls playsInline />
                      <figcaption>
                        <span>{draft?.metadata.recordingScope === "element" ? "Element recording" : "Tab or window recording"}</span>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={locked}
                          onClick={() => setDraft((p) => p && { ...p, recording: undefined, metadata: { ...p.metadata, recordingScope: null } })}
                        >
                          Remove
                        </Button>
                      </figcaption>
                    </figure>
                  ) : null}
                </div>
              ) : null}
              <label className="fbw-label" htmlFor="fbw-note">
                What should change?
              </label>
              <textarea
                id="fbw-note"
                className="fbw-note"
                rows={3}
                maxLength={MAX_NOTE_CHARS}
                placeholder="What happened, and what did you expect?"
                disabled={locked || !draft}
                value={draft?.metadata.note ?? ""}
                data-testid="feedback-note"
                onChange={(e) => {
                  const note = e.target.value;
                  setDraft((p) => p && { ...p, metadata: { ...p.metadata, note } });
                }}
              />
              <p className="fbw-help">Goes to {destinationLabel}. Drafts stay in this browser for 24 hours.</p>
              {draft?.sealed && !busy ? <p className="fbw-help">This draft is locked so a retry sends the same issue.</p> : null}
              {error ? (
                <p role="alert" className="fbw-error">
                  {error}
                </p>
              ) : null}
              <div className="fbw-row fbw-foot">
                {!draft?.sealed || error ? (
                  <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={discard}>
                    Discard draft
                  </Button>
                ) : null}
                <span className="fbw-grow" />
                {shortcutLabel ? (
                  <span className="fbw-hint" aria-hidden="true">
                    {shortcutLabel}
                  </span>
                ) : null}
                <Button variant="primary" disabled={Boolean(busy) || !draft || !noteOk} onClick={() => void submit()} data-testid="feedback-send">
                  {busy || (draft?.sealed ? "Retry" : "Send")}
                </Button>
              </div>
            </>
          )}
        </section>
      ) : null}
    </>
  );
}
