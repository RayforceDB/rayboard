// The Board count opens the board narrowed to what it counts (T-465): a request the Tasks view takes up whether it
// is already open or about to be.
let wanted = false;
const listeners = new Set<() => void>();
export function askOnlyUpdated(): void {
  wanted = true;
  for (const f of listeners) f();
}
/** Whether such a request is waiting; taking it clears it. */
export function takeOnlyUpdated(): boolean {
  const was = wanted;
  wanted = false;
  return was;
}
export function onAskOnlyUpdated(f: () => void): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}

/**
 * The updated tasks as the Board shows them: those in the chosen project, and how many more the sidebar count
 * includes from other projects. The count is never scoped, so the board must say where the rest are.
 */
export function updatedScope<T>(tasks: T[], isUpdated: (t: T) => boolean, inScope: (t: T) => boolean): { here: T[]; elsewhere: number; total: number } {
  const all = tasks.filter(isUpdated);
  const here = all.filter(inScope);
  return { here, elsewhere: all.length - here.length, total: all.length };
}
