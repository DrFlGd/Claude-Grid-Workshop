// Page side of the browser engine: compiles OpenSCAD once, runs each render in
// its own worker, and remembers finished renders for this visit.

const resolve = (p) => new URL(p, document.baseURI).href;

export class EngineClient {
  constructor({ commonFiles }) {
    this.commonFiles = commonFiles || {};
    this.results = new Map(); // settings key -> { blob, ms }
    this.module = null;
    this.ready = (WebAssembly.compileStreaming
      ? WebAssembly.compileStreaming(fetch(resolve("engine/openscad.wasm")))
      : fetch(resolve("engine/openscad.wasm")).then((r) => r.arrayBuffer()).then((b) => WebAssembly.compile(b)))
      .then((m) => { this.module = m; return m; })
      .catch(() => null); // the worker will load the engine itself
    this.canSendModule = true;
  }

  static key(model, values) {
    return JSON.stringify([model.key, Object.keys(values).sort().map((k) => [k, values[k]])]);
  }

  /**
   * Render a model. Returns { promise, cancel }. onEvent receives
   * { type: "stage", stage } and { type: "log", line }.
   */
  render(model, values, onEvent = () => {}) {
    const allValues = { ...values, ...(model.fixed || {}) };
    const key = EngineClient.key(model, allValues);
    const cached = this.results.get(key);
    if (cached) return { promise: Promise.resolve({ ...cached, cached: true }), cancel() {} };

    const files = {};
    for (const [p, sha] of Object.entries({ ...this.commonFiles, ...model.files })) files[p] = resolve(`fs/${sha}`);
    let worker = null;
    let cancelled = false;
    let rejectRun;
    const promise = new Promise((resolveRun, reject) => {
      rejectRun = reject;
      this.ready.then((module) => {
        if (cancelled) return;
        worker = new Worker(resolve("render-worker.js"), { type: "module" });
        worker.onmessage = ({ data }) => {
          if (data.type === "done") {
            worker.terminate();
            const result = { blob: new Blob([data.stl], { type: "model/stl" }), ms: data.ms, logs: data.logs };
            this.results.set(key, result);
            if (this.results.size > 40) this.results.delete(this.results.keys().next().value);
            resolveRun({ ...result, cached: false });
          } else if (data.type === "error") {
            worker.terminate();
            reject(Object.assign(new Error(data.error), { logs: data.logs }));
          } else {
            onEvent(data);
          }
        };
        worker.onerror = (e) => {
          worker.terminate();
          reject(new Error(e.message || "The render worker failed to start. Try reloading the page."));
        };
        const msg = { files, entry: model.entry, values: allValues };
        if (module && this.canSendModule) {
          try {
            worker.postMessage({ ...msg, module });
            return;
          } catch {
            this.canSendModule = false; // this browser can't share compiled modules with workers
          }
        }
        worker.postMessage(msg);
      });
    });
    return {
      promise,
      cancel() {
        cancelled = true;
        if (worker) worker.terminate();
        rejectRun(Object.assign(new Error("Render cancelled."), { cancelled: true }));
      },
    };
  }
}
