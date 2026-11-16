// @vitest-environment jsdom
/**
 * A panel that fails to download stays inside the widget: a short message with Try again and Close, never an error
 * thrown into the host page's error boundary.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { openFeedback, resetFeedbackState } from "./state";
import { FeedbackWidget } from "./widget";

vi.mock("./panel", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

class HostBoundary extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };
  static getDerivedStateFromError() {
    return { crashed: true };
  }
  render() {
    return this.state.crashed ? <p data-testid="host-crashed">The page crashed</p> : this.props.children;
  }
}

afterEach(() => {
  cleanup();
  resetFeedbackState();
});

it("a failed panel download shows the widget's own message, and the host page keeps working", async () => {
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  render(
    <HostBoundary>
      <p data-testid="host-content">Host page</p>
      <FeedbackWidget endpoint="/api/feedback" destinationLabel="X" draftScope="s" />
    </HostBoundary>,
  );
  act(() => {
    openFeedback();
  });
  expect((await screen.findByTestId("feedback-load-failed")).textContent).toMatch(/could not load/);
  expect(screen.queryByTestId("host-crashed")).toBeNull();
  expect(screen.getByTestId("host-content")).toBeTruthy();
  expect(screen.getByTestId("feedback-load-retry")).toBeTruthy();
  quiet.mockRestore();
});
