// @vitest-environment jsdom
/**
 * The widget in a page: the launcher and the shortcut open it, the host's openFeedback() works only while a widget is
 * mounted, the picker keeps every key from the page, a recording stamps the page it was made on, and a send posts to
 * the site's endpoint and shows the receipt (or keeps the sealed draft for a retry). The draft store, the tab lock,
 * the recorder and the network are stubbed at their boundaries.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureDraft } from "../contract";
import { openFeedback, resetFeedbackState, useFeedbackOpen } from "./state";
import { submitCapture } from "./submit";
import { TargetPicker } from "./target-picker";
import { FeedbackWidget } from "./widget";

const store = vi.hoisted(() => ({ saved: undefined as unknown, writes: [] as unknown[], scopes: [] as string[] }));

vi.mock("./draft-session", () => ({
  openDraftSession: (scope: string, ready: (key: string) => Promise<void>) => {
    store.scopes.push(scope);
    void ready(`${scope}:test-tab`);
    return () => {};
  },
}));
vi.mock("./draft-store", () => ({
  readDraft: async () => store.saved,
  writeDraft: async (_key: string, draft: unknown) => {
    store.writes.push(draft);
  },
}));
vi.mock("./recording", () => ({
  canRecord: () => true,
  canCropToElement: () => false,
  startRecording: async () => ({ stop: () => {}, finished: Promise.resolve(new Blob(["webm"], { type: "video/webm" })) }),
}));
vi.mock("./submit", () => ({ submitCapture: vi.fn() }));

function savedDraft(o: Partial<CaptureDraft["metadata"]> = {}): CaptureDraft {
  return {
    metadata: {
      id: "0f0e0d0c-0b0a-4900-8800-000000000001",
      note: "Started elsewhere",
      page: "/start",
      capturedAt: "2026-11-15T08:00:00.000Z",
      viewport: { width: 111, height: 222 },
      target: null,
      recordingScope: null,
      ...o,
    },
    sealed: false,
    expiresAt: Date.now() + 60_000,
  };
}

beforeEach(() => {
  resetFeedbackState();
  store.saved = undefined;
  store.writes = [];
  store.scopes = [];
  vi.mocked(submitCapture).mockReset();
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
  history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  resetFeedbackState();
});

describe("opening", () => {
  it("openFeedback() does nothing until a widget is mounted, then opens it", async () => {
    expect(openFeedback()).toBe(false);
    function Probe() {
      return <span data-testid="open">{String(useFeedbackOpen())}</span>;
    }
    render(
      <>
        <FeedbackWidget endpoint="/api/feedback" destinationLabel="X" draftScope="s" />
        <Probe />
      </>,
    );
    expect(screen.getByTestId("open").textContent).toBe("false");
    act(() => {
      expect(openFeedback()).toBe(true);
    });
    expect(screen.getByTestId("open").textContent).toBe("true");
    expect(await screen.findByTestId("feedback-panel")).toBeTruthy();
  });

  it("the launcher and Cmd/Ctrl+Shift+F toggle the panel; the panel loads on first open with the site's draft scope", async () => {
    render(<FeedbackWidget endpoint="/api/feedback" destinationLabel="The Ascent backlog" draftScope="ascent:user-1" />);
    expect(screen.queryByTestId("feedback-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("feedback-launcher"));
    expect(await screen.findByTestId("feedback-panel")).toBeTruthy();
    expect(screen.getByText(/Goes to The Ascent backlog/)).toBeTruthy();
    expect(store.scopes).toEqual(["ascent:user-1"]);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyF", key: "F", shiftKey: true, ctrlKey: true, bubbles: true }));
    });
    await waitFor(() => expect(screen.queryByTestId("feedback-panel")).toBeNull());
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyF", key: "F", shiftKey: true, metaKey: true, bubbles: true }));
    });
    expect(await screen.findByTestId("feedback-panel")).toBeTruthy();
  });

  it("launcher none and shortcut off leave the entry point to the site", () => {
    render(<FeedbackWidget endpoint="/api/feedback" destinationLabel="X" draftScope="s" launcher="none" shortcut={false} />);
    expect(screen.queryByTestId("feedback-launcher")).toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyF", key: "F", shiftKey: true, ctrlKey: true, bubbles: true }));
    });
    expect(screen.queryByTestId("feedback-panel")).toBeNull();
  });
});

describe("the picker", () => {
  it("keeps every key from the page while it is up; a key's own default still runs", () => {
    const page = vi.fn();
    window.addEventListener("keydown", page);
    document.addEventListener("keydown", page);
    render(<TargetPicker onChoose={vi.fn()} onCancel={vi.fn()} />);
    const bar = screen.getByTestId("feedback-picker");
    expect(document.activeElement).toBe(bar);
    for (const init of [{ key: "g" }, { key: "j" }, { key: "k", metaKey: true }]) {
      act(() => {
        bar.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }));
      });
    }
    expect(page).not.toHaveBeenCalled();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => {
      bar.dispatchEvent(tab);
    });
    expect(tab.defaultPrevented).toBe(false);
    window.removeEventListener("keydown", page);
    document.removeEventListener("keydown", page);
  });

  it("Esc cancels the picker", () => {
    const cancel = vi.fn();
    render(<TargetPicker onChoose={vi.fn()} onCancel={cancel} />);
    act(() => {
      screen.getByTestId("feedback-picker").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("the page a capture names", () => {
  it("a shared-surface recording made after navigating stamps the page (with its query) and viewport it was made on", async () => {
    store.saved = savedDraft();
    history.replaceState(null, "", "/climb/c-a0?step=2");
    render(<FeedbackWidget endpoint="/api/feedback" destinationLabel="X" draftScope="s" />);
    act(() => {
      openFeedback();
    });
    await waitFor(() => expect((screen.getByTestId("feedback-note") as HTMLTextAreaElement).value).toBe("Started elsewhere"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("feedback-record"));
    });
    await waitFor(() => expect(store.writes.some((d) => (d as CaptureDraft).recording)).toBe(true));
    const last = store.writes.at(-1) as CaptureDraft;
    expect(last.metadata.recordingScope).toBe("shared-surface");
    expect(last.metadata.page).toBe("/climb/c-a0?step=2");
    expect(last.metadata.viewport).toEqual({ width: innerWidth, height: innerHeight });
  });
});

describe("sending", () => {
  it("a site's own transport (the submit prop) sends the sealed draft instead of the default multipart POST", async () => {
    store.saved = savedDraft({ note: "Staged upload" });
    const transport = vi.fn().mockResolvedValue({ identifier: "NUD-7", url: "https://example.test/NUD-7" });
    render(<FeedbackWidget endpoint="/api/feedback-capture" destinationLabel="X" draftScope="s" submit={transport} />);
    act(() => {
      openFeedback();
    });
    await waitFor(() => expect((screen.getByTestId("feedback-note") as HTMLTextAreaElement).value).toBe("Staged upload"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("feedback-send"));
    });
    expect((await screen.findByTestId("feedback-receipt-link")).textContent).toBe("NUD-7");
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]![0]).toBe("/api/feedback-capture");
    expect(transport.mock.calls[0]![1].sealed).toBe(true);
    expect(vi.mocked(submitCapture)).not.toHaveBeenCalled();
  });

  it("a send that succeeds shows the receipt link; one that fails keeps the sealed draft and offers Retry", async () => {
    store.saved = savedDraft({ note: "Make Continue clearer" });
    const onSent = vi.fn();
    vi.mocked(submitCapture).mockRejectedValueOnce(new Error("Linear did not answer. Your draft is saved, so try again."));
    render(<FeedbackWidget endpoint="/api/site-feedback" destinationLabel="X" draftScope="s" onSent={onSent} />);
    act(() => {
      openFeedback();
    });
    await waitFor(() => expect((screen.getByTestId("feedback-note") as HTMLTextAreaElement).value).toBe("Make Continue clearer"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("feedback-send"));
    });
    expect((await screen.findByRole("alert")).textContent).toMatch(/Linear did not answer/);
    expect(screen.getByTestId("feedback-send").textContent).toBe("Retry");
    const sealed = vi.mocked(submitCapture).mock.calls[0]!;
    expect(sealed[0]).toBe("/api/site-feedback");
    expect(sealed[1].sealed).toBe(true);
    vi.mocked(submitCapture).mockResolvedValueOnce({ identifier: "ASC-901", url: "https://gateway.example/l/ASC-901" });
    await act(async () => {
      fireEvent.click(screen.getByTestId("feedback-send"));
    });
    const link = await screen.findByTestId("feedback-receipt-link");
    expect(link.textContent).toBe("ASC-901");
    expect(link.getAttribute("href")).toBe("https://gateway.example/l/ASC-901");
    expect(onSent).toHaveBeenCalledWith({ identifier: "ASC-901", url: "https://gateway.example/l/ASC-901" });
    // The retry sent the same capture.
    expect(vi.mocked(submitCapture).mock.calls[1]![1].metadata.id).toBe(sealed[1].metadata.id);
  });
});
