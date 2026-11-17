/** Hash routes carry identifiers, never URLs to fetch or HTML to render. */
export const VIEWS = ['overview', 'tasks', 'reviews', 'chat', 'agents', 'costs', 'activity'] as const;
export type Route = { view: string; item: string };

export function parseRoute(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const slash = raw.indexOf('/');
  const view = slash < 0 ? raw : raw.slice(0, slash);
  if (!(VIEWS as readonly string[]).includes(view)) return { view: 'overview', item: '' };
  try {
    return { view, item: slash < 0 ? '' : decodeURIComponent(raw.slice(slash + 1)) };
  } catch {
    // A malformed pasted link must not take down the whole signed-in UI.
    return { view, item: '' };
  }
}

export function routeHash(route: Route): string {
  const view = (VIEWS as readonly string[]).includes(route.view) ? route.view : 'overview';
  return `#${view}${route.item ? `/${encodeURIComponent(route.item)}` : ''}`;
}

/** Both address-bar hash changes and history traversal can change the view. */
export function listenToRoute(target: Window, changed: (route: Route) => void): () => void {
  const sync = () => changed(parseRoute(target.location.hash));
  target.addEventListener('hashchange', sync);
  target.addEventListener('popstate', sync);
  sync(); // Also closes the render-to-effect subscription window.
  return () => {
    target.removeEventListener('hashchange', sync);
    target.removeEventListener('popstate', sync);
  };
}
