// Frame list shared by all tablets. Registered PNGs are cached on the device
// (blobs in IndexedDB) so the booth keeps working without internet.

import { kv } from "./db.js";
import { builtinFrames } from "./layouts.js";

const CACHE_KEY = "frames";

export class FrameLibrary extends EventTarget {
  constructor(api, eventName) {
    super();
    this.api = api;
    this.builtins = builtinFrames(eventName);
    this.registered = []; // { id, name, layout, kind: "png", createdAt, blob }
    this.images = new Map(); // id → ImageBitmap
    this.lastRefresh = 0;
  }

  async loadCache() {
    const cached = (await kv.get(CACHE_KEY)) ?? [];
    this.registered = cached.map((f) => ({ ...f, kind: "png" }));
    this.changed();
  }

  // Replaces the list with the server's, downloading only frames we don't
  // already have. On any failure the cached list stays as it was.
  async refresh() {
    const { frames } = await this.api.listFrames();
    const known = new Map(this.registered.map((f) => [f.id, f]));
    const next = [];
    for (const remote of frames) {
      let blob = known.get(remote.id)?.blob;
      if (!blob) {
        const res = await fetch(remote.url, { cache: "no-store" });
        if (!res.ok) throw new Error(`frame download ${res.status}`);
        blob = await res.blob();
      }
      next.push({ id: remote.id, name: remote.name, layout: remote.layout, createdAt: remote.createdAt, blob, kind: "png" });
    }
    for (const id of this.images.keys()) {
      if (!next.some((f) => f.id === id)) {
        this.images.get(id)?.close?.();
        this.images.delete(id);
      }
    }
    this.registered = next;
    this.lastRefresh = Date.now();
    await kv.set(CACHE_KEY, next.map(({ kind, ...rest }) => rest));
    this.changed();
  }

  byLayout(layout) {
    return [...this.registered.filter((f) => f.layout === layout), ...this.builtins.filter((f) => f.layout === layout)];
  }

  async imageFor(frame) {
    if (frame.kind !== "png") return null;
    if (!this.images.has(frame.id)) this.images.set(frame.id, await createImageBitmap(frame.blob));
    return this.images.get(frame.id);
  }

  changed() {
    this.dispatchEvent(new Event("change"));
  }
}
