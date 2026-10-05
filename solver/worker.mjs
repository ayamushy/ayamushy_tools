/* Worker entry point. Loads the WASM module once, then handles "solve"
 * messages by running the C solver synchronously inside the worker thread.
 * Terminate the worker (from the main thread) to cancel an in-flight solve. */

import legionInit from './legion.js?v=274213b5';
import { computeLayout, runSolve, warmUp } from './solve-impl.mjs?v=274213b5';

let mod = null;
let layout = null;

self.addEventListener('message', async (e) => {
  const msg = e.data;

  if (msg.type === 'init') {
    try {
      mod = await legionInit({
        /* keep this module's ?v= cache-bust query on legion.wasm too (build_site.py) */
        locateFile: (path) => {
          const u = new URL(path, import.meta.url);
          u.search = new URL(import.meta.url).search;
          return u.href;
        },
      });
      layout = computeLayout(mod);
      warmUp(mod, layout);
      self.postMessage({ type: 'ready', layout });
    } catch (err) {
      self.postMessage({ type: 'init-error', error: String(err && err.message || err) });
    }
    return;
  }

  if (msg.type === 'solve') {
    if (!mod || !layout) {
      self.postMessage({
        type: 'error',
        requestId: msg.requestId,
        error: 'solve before init',
      });
      return;
    }
    try {
      const result = runSolve(mod, layout, msg.board, msg.counts, msg.maxIter, msg.strategy || 0);
      self.postMessage({ type: 'result', requestId: msg.requestId, result });
    } catch (err) {
      self.postMessage({
        type: 'error',
        requestId: msg.requestId,
        error: String(err && err.message || err),
      });
    }
  }
});
