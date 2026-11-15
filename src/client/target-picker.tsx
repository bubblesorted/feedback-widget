/**
 * The element picker. The outline follows the pointer; a click holds an element without activating it; P and C move
 * to the parent and the child; Enter or "Use element" takes it. Esc cancels the picker first: its capture-phase
 * listener takes the key before the host page can see it. No other key reaches the page while the picker is up
 * either. Clicks and keys inside the picker's own bar are the bar's.
 */

import { useEffect, useRef, useState } from "react";

import { CAPTURE_UI, describeTarget, parentOf, targetAt, visibleChild } from "./picker";
import { Button } from "./ui";

export function TargetPicker({ onChoose, onCancel }: { onChoose: (element: Element) => void; onCancel: () => void }) {
  const [candidate, setCandidate] = useState<Element | null>(null);
  const [locked, setLocked] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const current = useRef<Element | null>(null);
  const history = useRef<Element[]>([]);
  const bar = useRef<HTMLElement>(null);

  const select = (element: Element | null) => {
    current.current = element;
    setCandidate(element);
    setRect(element?.getBoundingClientRect() ?? null);
  };
  const expand = () => {
    if (!current.current) return;
    const parent = parentOf(current.current);
    if (parent && parent !== document.documentElement && parent !== document.body) {
      history.current.push(current.current);
      select(parent);
    }
  };
  const shrink = () => {
    if (current.current) select(history.current.pop() ?? visibleChild(current.current) ?? current.current);
  };

  // The bar takes focus, so the keyboard's next key is the picker's, and screen readers hear its status.
  useEffect(() => {
    bar.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const isUI = (event: Event) => event.composedPath().some((node) => node instanceof Element && node.matches(CAPTURE_UI));
    const move = (event: PointerEvent) => {
      if (!locked && !isUI(event)) select(targetAt(event.clientX, event.clientY));
    };
    const block = (event: Event) => {
      if (!isUI(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const click = (event: MouseEvent) => {
      if (isUI(event)) return;
      block(event);
      if (!locked) {
        select(targetAt(event.clientX, event.clientY));
        setLocked(true);
        history.current = [];
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCancel();
        return;
      }
      // Every other key stops here too, so nothing behind the picker acts on it: not the host's shortcuts (g then a
      // letter, j and k, page keys, Cmd+K), not a page's own listener. Only propagation stops; the key's default
      // still runs, so Tab moves through the bar, Space and Enter press its focused button, and browser keys work.
      event.stopImmediatePropagation();
      if (!locked || event.metaKey || event.ctrlKey || event.altKey) return;
      const k = event.key.toLowerCase();
      if (k === "p" || k === "c") {
        event.preventDefault();
        if (k === "p") expand();
        else shrink();
        return;
      }
      if (event.key === "Enter" && current.current && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        onChoose(current.current);
      }
    };
    let frame = 0;
    const follow = () => {
      if (current.current) setRect(current.current.getBoundingClientRect());
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerdown", block, true);
    document.addEventListener("pointerup", block, true);
    document.addEventListener("mousedown", block, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerdown", block, true);
      document.removeEventListener("pointerup", block, true);
      document.removeEventListener("mousedown", block, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
    };
    // expand and shrink read refs only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, onChoose, onCancel]);

  const target = locked && candidate ? describeTarget(candidate) : null;
  return (
    <div data-feedback-capture="picker">
      {rect ? <div className="fbw-outline" data-locked={locked ? "" : undefined} style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }} aria-hidden="true" /> : null}
      <section ref={bar} className="fbw-picker" aria-label="Element picker" tabIndex={-1} data-testid="feedback-picker">
        <p role="status" className="fbw-status">
          {target ? (
            <>
              <b>{target.tag}</b> {Math.round(rect?.width ?? 0)} by {Math.round(rect?.height ?? 0)}
            </>
          ) : (
            "Point to an element, then click to hold it."
          )}
        </p>
        {target ? (
          <code className="fbw-sel" data-tip={target.selector} data-testid="feedback-picker-selector">
            {target.selector}
          </code>
        ) : null}
        <div className="fbw-row">
          <Button size="sm" disabled={!locked} onClick={expand} kbd="P">
            Parent
          </Button>
          <Button size="sm" disabled={!locked} onClick={shrink} kbd="C">
            Child
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!locked}
            onClick={() => {
              setLocked(false);
              select(null);
            }}
          >
            Pick again
          </Button>
          <span className="fbw-grow" />
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" disabled={!locked || !candidate} onClick={() => candidate && onChoose(candidate)} data-testid="feedback-use-element">
            Use element
          </Button>
        </div>
      </section>
    </div>
  );
}
