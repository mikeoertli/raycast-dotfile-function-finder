import type { Definition } from "./parser";

export const RESULTS_PER_PAGE = 200;

// Page the presentation, never the search index. Every match remains reachable
// without building thousands of React detail/action trees at once.
export function resultPage(items: Definition[], requestedPage: number) {
  const pages = Math.max(1, Math.ceil(items.length / RESULTS_PER_PAGE));
  const page = Math.max(0, Math.min(requestedPage, pages - 1));
  const offset = page * RESULTS_PER_PAGE;
  return {
    items: items.slice(offset, offset + RESULTS_PER_PAGE),
    page,
    pages,
    start: items.length ? offset + 1 : 0,
    end: Math.min(offset + RESULTS_PER_PAGE, items.length),
  };
}
