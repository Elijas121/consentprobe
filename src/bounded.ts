/** Time limit for a single question to the page (visibility, text, DOM checks). */
export const QUERY_MS = 3000;

/** Counts page queries that ran into their time limit during one visit. */
export interface QueryBudget {
  timeouts: number;
  /** Frames that did not answer once; they are skipped afterwards instead of costing a timeout each time. */
  deadFrames: WeakSet<object>;
}

export const newBudget = (): QueryBudget => ({ timeouts: 0, deadFrames: new WeakSet() });

/**
 * Resolve with `fallback()` when `promise` does not settle within `ms`. Some Playwright calls
 * (isVisible, count, evaluate) have no timeout of their own and wait forever on a frozen frame.
 */
export function bounded<T>(promise: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        resolve(fallback());
      } catch (err) {
        reject(err);
      }
    }, ms);
    timer.unref();
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/**
 * Like `bounded`, for page queries: a timeout or error yields `fallback`. Errors are always
 * handled, also when the answer arrives after the time limit (e.g. "browser closed"). A timeout is counted in
 * `q`, and the frame it concerned (if given) is marked dead so it is not asked again.
 */
export function ask<T>(query: () => Promise<T>, q: QueryBudget, fallback: T, frame?: object, ms = QUERY_MS): Promise<T> {
  // A thunk, so nothing is sent to a frame that is already known to be dead.
  if (frame && q.deadFrames.has(frame)) return Promise.resolve(fallback);
  let promise: Promise<T>;
  try {
    promise = query();
  } catch {
    return Promise.resolve(fallback);
  }
  return bounded(
    promise.catch(() => fallback),
    ms,
    () => {
      q.timeouts += 1;
      if (frame) q.deadFrames.add(frame);
      return fallback;
    },
  );
}
