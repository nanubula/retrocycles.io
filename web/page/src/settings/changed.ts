// "A setting changed": the store (store.ts) says so after it saved and when a page key is
// written, and the account sync (configSync.ts) listens. A small bus so the store calls no network.
const listeners = new Set<() => void>();

export function noteSettingsChanged(): void {
  for (const fn of listeners) fn();
}

export function onSettingsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
