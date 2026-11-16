/**
 * The widget's open state: one small store, so a host's own button, command palette or menu can open it without a
 * provider. Only one widget mounts per page.
 */

import { useSyncExternalStore } from "react";

let mounted = 0;
let open = false;
// Counts open requests, so a request while already open (from a menu or palette) still moves focus into the panel.
let requests = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** The widget registers itself while mounted; openFeedback() does nothing without one. */
export function registerWidget(): () => void {
  mounted++;
  emit();
  return () => {
    mounted--;
    if (mounted <= 0) {
      mounted = 0;
      open = false;
    }
    emit();
  };
}

/** Opens the panel. Returns false when no widget is mounted on this page (feedback is not available here). */
export function openFeedback(): boolean {
  if (!mounted) return false;
  open = true;
  requests++;
  emit();
  return true;
}

export function closeFeedback(): void {
  if (!open) return;
  open = false;
  emit();
}

export function toggleFeedback(): void {
  if (open) closeFeedback();
  else openFeedback();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useFeedbackOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open, () => false);
}

/** Increments on every openFeedback(), for the panel to take focus again. */
export function useFeedbackOpenRequest(): number {
  return useSyncExternalStore(subscribe, () => requests, () => 0);
}

/** Whether a widget is mounted, for a host that shows its own entry point. */
export function useFeedbackAvailable(): boolean {
  return useSyncExternalStore(subscribe, () => mounted > 0, () => false);
}

/** Test seam. */
export function resetFeedbackState(): void {
  open = false;
  mounted = 0;
  requests = 0;
  emit();
}
