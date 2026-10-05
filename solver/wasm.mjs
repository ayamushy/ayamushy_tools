/* Public client API for the solver.
 *
 * solve() returns a Promise. Under the hood:
 *   - Worker mode: a small pool of Web Workers, one per CPU core (up to the
 *     number of search strategies). Every solve races the strategies, one per
 *     worker; the first definitive answer wins and the rest are terminated.
 *     They explore in different orders, and on a given board one order can be
 *     10-100x faster than another, so racing them cuts the slow tail a lot.
 *     One racer is the original v1 search: occasionally very lucky on easy
 *     boards, but its "no solution" can be wrong, so only its successes count.
 *     Fresh workers run a warm-up solve before joining (see warmUp).
 *   - Single-file/file:// mode: the worker source is embedded as base64 and
 *     spawned from a Blob URL.
 *   - If no worker can be spawned at all, falls back to running strategy 0 on
 *     the main thread (page freezes during the solve, same as before workers). */

import legionInit from './legion.js?v=274213b5';
import { computeLayout, runSolve } from './solve-impl.mjs?v=274213b5';

/* Replaced at build time by build_single_html.ps1 with the bundled worker IIFE
 * encoded as base64. In dev mode this stays as the literal sentinel (~34 chars);
 * the length check below is how we detect "has been replaced". Base64 is used
 * (instead of an escaped JS string literal) because the worker bundle contains
 * the WASM binary as a heavily-escaped JS string, and a second round of
 * escaping was producing invalid syntax. */
const EMBEDDED_WORKER_SRC_B64 = '__LEGION_WORKER_SRC_PLACEHOLDER__';

let embeddedWorkerUrl = null;   /* Blob URL, created once and reused for every worker */
function embeddedWorkerBlobUrl() {
  if (!embeddedWorkerUrl) {
    /* base64 -> Uint8Array of UTF-8 bytes (the worker bundle source). */
    const bin = atob(EMBEDDED_WORKER_SRC_B64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    embeddedWorkerUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/javascript' }));
  }
  return embeddedWorkerUrl;
}

/* Which strategy each pool slot runs, by priority: a 1-worker pool still gets
 * a complete search (v2 strategy 0), then the v1 search, then the other v2
 * orders. Filled in from the layout (STRATEGY_V1 = last id). */
function strategyOrder(L) {
  const v1 = L.N_STRATEGIES - 1;
  const rest = Array.from({ length: v1 - 1 }, (_, i) => i + 1);
  return [0, v1, ...rest];
}

/* Upper bound on parallel workers. Leaves one core for the UI.
 * Override with ?workers=N in the page URL (1 = a single strategy). */
const MAX_POOL = (() => {
  const forced = parseInt(new URLSearchParams(globalThis.location?.search || '').get('workers'), 10);
  if (forced > 0) return forced;
  return Math.max(1, Math.min(5, (navigator.hardwareConcurrency || 2) - 1));
})();

let mode = 'unknown';     /* 'worker' | 'sync' */
let pool = [];            /* initialised workers */
let spawnKind = null;     /* 'url' | 'blob' — whichever worked first */
let mainModule = null;    /* Emscripten Module on the main thread (sync mode) */
let layout = null;
let initPromise = null;
let active = null;        /* in-flight solve: { requestId, resolve, reject, ... } */
let nextRequestId = 1;

/* Wait for the worker's 'ready' (or 'init-error') reply to an 'init' message. */
function initWorker(w) {
  return new Promise((resolve, reject) => {
    const onMsg = (e) => {
      if (e.data.type === 'ready') {
        cleanup();
        resolve(e.data.layout);
      } else if (e.data.type === 'init-error') {
        cleanup();
        reject(new Error(e.data.error));
      }
    };
    const onErr = (e) => {
      cleanup();
      reject(new Error(e.message || 'worker error'));
    };
    const cleanup = () => {
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    w.postMessage({ type: 'init' });
  });
}

async function trySpawn(kind) {
  let w;
  try {
    if (kind === 'url') {
      /* dev mode — wasm.mjs is served from a real URL */
      if (typeof import.meta === 'undefined' || !import.meta.url) return null;
      w = new Worker(new URL('./worker.mjs?v=274213b5', import.meta.url), { type: 'module' });
    } else {
      /* single-file build — classic worker, embedded source is an IIFE */
      if (EMBEDDED_WORKER_SRC_B64.length <= 1000) return null;
      w = new Worker(embeddedWorkerBlobUrl());
    }
  } catch (err) {
    console.warn(`[legion-solver] ${kind}-worker spawn failed:`, err);
    return null;
  }
  try {
    layout = await initWorker(w);
    return w;
  } catch (err) {
    w.terminate();
    console.warn(`[legion-solver] ${kind}-worker init failed:`, err);
    return null;
  }
}

async function spawnWorker() {
  if (spawnKind) return trySpawn(spawnKind);
  for (const kind of ['url', 'blob']) {
    const w = await trySpawn(kind);
    if (w) { spawnKind = kind; return w; }
  }
  return null;
}

async function initSyncFallback() {
  mainModule = await legionInit({
    /* keep this module's ?v= cache-bust query on legion.wasm too (build_site.py) */
    locateFile: (path) => {
      const u = new URL(path, import.meta.url);
      u.search = new URL(import.meta.url).search;
      return u.href;
    },
  });
  layout = computeLayout(mainModule);
}

export async function initSolver() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const first = await spawnWorker();
    if (first) {
      const size = Math.min(MAX_POOL, layout.N_STRATEGIES);
      const rest = await Promise.all(Array.from({ length: size - 1 }, spawnWorker));
      pool = [first, ...rest.filter(Boolean)];
      for (const w of pool) w.addEventListener('message', handleWorkerMessage);
      mode = 'worker';
      console.log(`[legion-solver] ${pool.length} worker(s), racing ${pool.length} search strategies per solve`);
      return;
    }
    await initSyncFallback();
    mode = 'sync';
    console.log('[legion-solver] worker unavailable, solving on main thread (page may freeze on big solves)');
  })();
  return initPromise;
}

export function getLayout() {
  if (!layout) throw new Error('initSolver() not awaited yet');
  return layout;
}

export function isAsync() { return mode === 'worker'; }

/* Number of strategies raced per solve (1 in sync mode). */
export function parallelism() { return mode === 'worker' ? pool.length : 1; }

/* Kill the workers still grinding on the last solve (terminate() is the only
 * way to stop WASM mid-loop) and spawn warm replacements in the background.
 * Workers that already answered stay: they're idle and already warm. */
function replaceBusy(busy) {
  if (busy.size === 0) return;
  for (const w of busy) w.terminate();
  pool = pool.filter((w) => !busy.has(w));
  const need = busy.size;
  initPromise = (async () => {
    /* let the page draw the result first — creating workers costs main-thread time */
    await new Promise((r) => setTimeout(r, 150));
    const fresh = await Promise.all(Array.from({ length: need }, spawnWorker));
    for (const w of fresh) {
      if (!w) continue;
      w.addEventListener('message', handleWorkerMessage);
      pool.push(w);
    }
  })();
}

/* Staggered start: the first FIRST_WAVE racers start at once, the rest only if
 * there's no answer after STAGGER_MS. Easy boards are done in a few ms, and
 * spinning up every worker for them cost ~20 ms of page time (measured). */
const FIRST_WAVE = 2;
const STAGGER_MS = 30;

function startRacers(a, n) {
  for (let k = 0; k < n && a.queue.length; k++) {
    const { w, strategy } = a.queue.shift();
    a.pending++;
    a.started++;
    a.busy.add(w);
    /* Copy buffers — main thread keeps ownership of state.board / state.counts. */
    w.postMessage({
      type: 'solve',
      requestId: a.requestId,
      board:  new Int8Array(a.board),
      counts: new Int32Array(a.counts),
      maxIter: a.maxIter,
      strategy,
    });
  }
}

function finish(fn) {
  const a = active;
  active = null;
  clearTimeout(a.timer);
  replaceBusy(a.busy);
  fn(a);
}

/* every running racer has answered without a definitive result */
function allAnswered(a) {
  if (a.queue.length) { startRacers(a, a.queue.length); return; }   /* not everyone ran yet */
  if (a.capped) { a.capped.strategies = a.started; finish((x) => x.resolve(x.capped)); }
  else finish((x) => x.reject(new Error(x.errors[0])));
}

function handleWorkerMessage(e) {
  const msg = e.data;
  if (msg.type !== 'result' && msg.type !== 'error') return;
  const a = active;
  if (!a || msg.requestId !== a.requestId) return;
  a.pending--;
  a.busy.delete(e.target);

  if (msg.type === 'error') {
    a.errors.push(msg.error);
    if (a.pending === 0) allAnswered(a);
    return;
  }

  const r = msg.result;
  const hitCap = !r.success && a.maxIter > 0 && r.iterations >= a.maxIter;
  /* v1's "no solution" isn't a proof: treat it like a capped run */
  const definitive = r.success || (!hitCap && layout.COMPLETE[r.strategy]);
  if (definitive) {
    /* a solution, or a complete proof that none exists — either way, done */
    r.strategies = a.started;
    r.isV1 = !layout.COMPLETE[r.strategy];
    finish((x) => x.resolve(r));
    return;
  }
  /* this strategy ran out of iterations (or can't prove "none"); keep waiting */
  if (!a.capped || r.iterations > a.capped.iterations) a.capped = r;
  if (a.pending === 0) allAnswered(a);
}

export async function solve(board, counts, maxIter = 0) {
  if (!initPromise) initSolver();
  await initPromise;
  if (mode === 'worker' && pool.length === 0) {
    /* every replacement worker failed to spawn — start over (worker or sync) */
    mode = 'unknown';
    initPromise = null;
    await initSolver();
  }

  if (mode === 'worker') {
    const requestId = nextRequestId++;
    return new Promise((resolve, reject) => {
      const order = strategyOrder(layout);
      const a = active = {
        requestId, resolve, reject, maxIter, board, counts,
        pending: 0, started: 0, errors: [], capped: null, busy: new Set(),
        queue: pool.map((w, slot) => ({ w, strategy: order[slot] })),
        timer: null,
      };
      startRacers(a, FIRST_WAVE);
      a.timer = setTimeout(() => { if (active === a) startRacers(a, a.queue.length); }, STAGGER_MS);
    });
  }

  /* Sync fallback: run on main thread. Wrapped in Promise so the call site
   * still awaits. */
  const r = runSolve(mainModule, layout, board, counts, maxIter, 0);
  r.strategies = 1;
  return r;
}

/* Cancel the in-flight solve, if any. Only meaningful in worker mode.
 * Returns true if a solve was cancelled, false otherwise (e.g. sync mode). */
export function cancelSolve() {
  if (mode !== 'worker' || !active) return false;
  const a = active;
  active = null;
  clearTimeout(a.timer);
  replaceBusy(a.busy);
  a.reject(new Error('cancelled'));
  return true;
}
