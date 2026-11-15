/**
 * One draft per tab, duplicated tabs included: a tab id in
 * sessionStorage, held with a Web Lock; a duplicated tab finds the lock taken and takes a new id.
 */

const TAB_KEY = "feedback-widget-tab";

// React can remount before a lock callback finishes releasing: lifetimes in this document run one after another.
let previousSession: Promise<void> = Promise.resolve();

export function openDraftSession(scope: string, ready: (key: string) => Promise<void>, fail: (error: unknown) => void): () => void {
  let closed = false;
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = previousSession;
  const activate = async () => {
    await previous;
    if (closed) return;
    const tab = sessionStorage.getItem(TAB_KEY) ?? crypto.randomUUID();
    sessionStorage.setItem(TAB_KEY, tab);
    const key = `${scope}:${tab}`;
    if (!navigator.locks) {
      if (!closed) await ready(key);
      return;
    }
    await navigator.locks.request(`feedback-widget:${key}`, { ifAvailable: true }, async (lock) => {
      if (closed) return;
      if (!lock) {
        const independent = crypto.randomUUID();
        sessionStorage.setItem(TAB_KEY, independent);
        await navigator.locks.request(`feedback-widget:${scope}:${independent}`, async () => {
          if (!closed) await ready(`${scope}:${independent}`);
          await held;
        });
      } else {
        await ready(key);
        await held;
      }
    });
  };
  previousSession = activate().catch(fail);
  return () => {
    closed = true;
    release?.();
  };
}
