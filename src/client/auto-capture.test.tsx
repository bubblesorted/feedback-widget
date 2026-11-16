// @vitest-environment jsdom
/**
 * Picking an element takes its image straight away, so a capture never reaches Linear without a picture just because
 * a separate Capture image click was missed. The picker, the renderer, the draft store and the network are stubbed.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { openFeedback, resetFeedbackState } from "./state";
import { FeedbackWidget } from "./widget";

const shot = vi.hoisted(() => ({ domToBlob: vi.fn() }));

vi.mock("modern-screenshot", () => shot);
vi.mock("./draft-session", () => ({
  openDraftSession: (scope: string, ready: (key: string) => Promise<void>) => {
    void ready(`${scope}:test-tab`);
    return () => {};
  },
}));
vi.mock("./draft-store", () => ({ readDraft: async () => undefined, writeDraft: async () => {} }));
vi.mock("./recording", () => ({ canRecord: () => false, canCropToElement: () => false, startRecording: vi.fn() }));
vi.mock("./submit", () => ({ submitCapture: vi.fn() }));
vi.mock("./target-picker", () => ({
  TargetPicker: ({ onChoose }: { onChoose: (element: Element) => void }) => (
    <button type="button" data-testid="stub-use-element" onClick={() => onChoose(document.getElementById("chosen")!)}>
      Use element
    </button>
  ),
}));

beforeEach(() => {
  resetFeedbackState();
  shot.domToBlob.mockReset();
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
  document.body.insertAdjacentHTML("beforeend", '<h2 id="chosen">Author</h2>');
});

afterEach(() => {
  cleanup();
  resetFeedbackState();
  document.getElementById("chosen")?.remove();
});

async function pick() {
  render(<FeedbackWidget endpoint="/api/feedback" destinationLabel="X" draftScope="s" />);
  act(() => {
    openFeedback();
  });
  const button = await screen.findByTestId("feedback-pick");
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  const use = await screen.findByTestId("stub-use-element");
  await act(async () => {
    fireEvent.click(use);
  });
}

it("picking an element captures its image without a Capture image click", async () => {
  shot.domToBlob.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
  await pick();
  await waitFor(() => expect(screen.getByTestId("feedback-image")).toBeTruthy());
  expect(shot.domToBlob).toHaveBeenCalledOnce();
  expect(shot.domToBlob.mock.calls[0]![0]).toBe(document.getElementById("chosen"));
});

it("a failed automatic capture says so and leaves the pick in place", async () => {
  shot.domToBlob.mockRejectedValue(new Error("The image could not be captured. Try recording the element instead."));
  await pick();
  expect((await screen.findByRole("alert")).textContent).toMatch(/could not be captured/);
  expect(screen.getByTestId("feedback-target")).toBeTruthy();
  expect(screen.queryByTestId("feedback-image")).toBeNull();
});
