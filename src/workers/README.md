# `src/workers` — Web Workers

A worker runs CPU-heavy work off the main thread, so that the window never freezes. Today there is one: the zstd compression of the match archive, which takes long enough at level 19 to be felt on a large file.

## Rules

- Pure CPU work only: a worker reads no file, calls no network and touches no storage, because the page owns every side effect (see `ports/`).
- May import `core/` and npm packages only (enforced by ESLint), never `ports/`, `services/`, an adapter or `@tauri-apps/*`.
- A worker talks to the main thread only by messages. The message types live in `core/` (for zstd, `core/compression/zstd-protocol.ts`), so the worker and the adapter that starts it share one definition without importing each other.
- One file per worker, named `<name>.worker.ts`. It only does the plumbing: receive a request, call the logic, post the answer. The logic lives in a sibling module that is unit-tested on its own, because jsdom has no `Worker` (`zstd-codec.ts` next to `zstd.worker.ts`).
- A worker answers every request that carries a usable `id`, with the result or with the message of the failure, and never lets an exception escape: the page has no timeout, so an unanswered request would leave its caller waiting for ever. The answer carries the `id` of the request, so concurrent requests pair up.
- A worker file is never imported. The adapter in `src/adapters/browser/` starts it with `new Worker(new URL(…, import.meta.url), { type: 'module' })`, the form Vite recognises to bundle the worker as a chunk of the app's own origin, which the Content-Security-Policy allows (`worker-src 'self'`).

## Contents

| File             | Purpose                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `zstd.worker.ts` | Entry point of the zstd worker: answers the `compress` and `decompress` requests of `WorkerCompressor`                 |
| `zstd-codec.ts`  | The compression itself: `@hpcc-js/wasm-zstd` (zstd in WebAssembly, loaded on the first call), at level 19; unit-tested |
