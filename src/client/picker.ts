/**
 * The element picker's DOM helpers. Never reads input
 * values or the page's HTML: a target is its locator, tag, accessible label or visible text (160 characters) and box.
 */

import type { CaptureTarget } from "../contract";

/** Everything feedback capture draws: the picker ignores it and the image leaves it out. */
export const CAPTURE_UI = "[data-feedback-capture]";

export function parentOf(element: Element): Element | null {
  const root = element.getRootNode();
  return element.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
}

/** Prefer the actual control when the pointer lands on its icon or label. */
export function targetAt(x: number, y: number): Element | null {
  let element = document.elementFromPoint(x, y);
  while (element?.shadowRoot) {
    const child = element.shadowRoot.elementFromPoint(x, y);
    if (!child || child === element) break;
    element = child;
  }
  if (!element || element.closest(CAPTURE_UI) || element === document.documentElement || element === document.body) return null;
  return element.closest('button,a,input,select,textarea,[role="button"],[role="link"]') ?? (element instanceof SVGElement ? (element.closest("svg") ?? element) : element);
}

const escapeId = (id: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/[^\w-]/g, (c) => `\\${c}`));

/** A locator: a unique id where there is one, else nth-of-type steps. Shadow boundaries are written `>>>`. */
export function locator(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && parts.length < 24) {
    const root = current.getRootNode() as Document | ShadowRoot;
    if (current.id && root.querySelectorAll(`#${escapeId(current.id)}`).length === 1) {
      parts.unshift(`#${escapeId(current.id)}`);
      if (root instanceof Document) break;
      parts.unshift(">>>");
      current = (root as ShadowRoot).host;
      continue;
    }
    const tag = current.tagName;
    const siblings = Array.from(current.parentNode?.children ?? []).filter((node) => node.tagName === tag);
    parts.unshift(`${tag.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`);
    if (!current.parentElement && root instanceof ShadowRoot) parts.unshift(">>>");
    current = parentOf(current);
  }
  return parts.join(" > ").replaceAll(" > >>> > ", " >>> ").slice(0, 2000);
}

export function describeTarget(element: Element): CaptureTarget {
  const { x, y, width, height } = element.getBoundingClientRect();
  const label = element.getAttribute("aria-label");
  const shown = element instanceof HTMLElement ? (element.innerText ?? element.textContent ?? "") : (element.textContent ?? "");
  return {
    selector: locator(element),
    tag: element.tagName.toLowerCase().slice(0, 40),
    text: (label ?? shown).trim().replace(/\s+/g, " ").slice(0, 160),
    rect: { x, y, width: Math.max(width, 1), height: Math.max(height, 1) },
  };
}

export function visibleChild(element: Element): Element | null {
  return (
    Array.from(element.shadowRoot?.children ?? element.children).find((child) => {
      const rect = child.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !child.matches(CAPTURE_UI);
    }) ?? null
  );
}
