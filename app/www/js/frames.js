// Frame list shared by all tablets. Registered PNGs are cached on the device
// (blobs in IndexedDB) so the booth keeps working without internet.

import { kv } from "./db.js";
import { builtinFrames } from "./layouts.js";
import { readSlots } from "./compose.js";

const CACHE_KEY = "frames";
const PEOPLE_KEY = "people";
const LABEL_KEY = "people-label";

export class FrameLibrary extends EventTarget {
  constructor(api, eventName) {
    super();
    this.api = api;
    this.builtins = builtinFrames(eventName);
    this.registered = []; // { id, name, layout, kind: "png", createdAt, blob }
    this.people = []; // { id, name, blob } — cut-outs the guests pose with
    this.peopleLabel = "친구"; // what the booth's button calls them
    this.images = new Map(); // id → ImageBitmap
    this.slots = new Map(); // id → the cuts read out of that frame's transparency
    this.lastRefresh = 0;
  }

  async loadCache() {
    const [frames, people, label] = await Promise.all([kv.get(CACHE_KEY), kv.get(PEOPLE_KEY), kv.get(LABEL_KEY)]);
    this.registered = (frames ?? []).map((f) => ({ ...f, kind: "png" }));
    this.people = people ?? [];
    this.peopleLabel = label ?? "친구";
    this.changed();
  }

  // Replaces the list with the server's, downloading only frames we don't
  // already have. On any failure the cached list stays as it was.
  async refresh() {
    const { frames, people = [], peopleLabel } = await this.api.listFrames();
    if (peopleLabel) {
      this.peopleLabel = peopleLabel;
      await kv.set(LABEL_KEY, peopleLabel);
    }
    await this.refreshPeople(people);
    const known = new Map(this.registered.map((f) => [f.id, f]));
    const next = [];
    for (const remote of frames) {
      let blob = known.get(remote.id)?.blob;
      if (!blob) {
        const res = await fetch(remote.url, { cache: "no-store" });
        if (!res.ok) throw new Error(`frame download ${res.status}`);
        blob = await res.blob();
      }
      next.push({
        id: remote.id,
        name: remote.name,
        layout: remote.layout,
        showWhileShooting: remote.hasPeople === true,
        secret: remote.secret === true,
        createdAt: remote.createdAt,
        blob,
        kind: "png",
      });
    }
    for (const id of this.images.keys()) {
      if (!next.some((f) => f.id === id)) {
        this.images.get(id)?.close?.();
        this.images.delete(id);
        this.slots.delete(id);
      }
    }
    // Frames that survived keep their cuts; the list objects are new each time.
    for (const frame of next) frame.slots ??= this.slots.get(frame.id) ?? undefined;
    this.registered = next;
    this.lastRefresh = Date.now();
    await kv.set(CACHE_KEY, next.map(({ kind, ...rest }) => rest));
    this.changed();
  }

  // What the guests may choose from: the frames this booth was given, and
  // nothing else. The plain white and black ones are no longer offered —
  // they stay in the code only as the stand-in a shoot uses before its frame
  // has been chosen.
  //
  // Secret frames are downloaded and kept like any other — the operator
  // shoots with them from the desk — but they never appear on this screen.
  byLayout(layout) {
    return this.registered.filter((f) => f.layout === layout && !f.secret);
  }

  // Same trick as the frames: download a cut-out once, keep the blob on the
  // device so the booth works without internet.
  async refreshPeople(remote) {
    const known = new Map(this.people.map((p) => [p.id, p]));
    const next = [];
    for (const person of remote) {
      let blob = known.get(person.id)?.blob;
      if (!blob) {
        const res = await fetch(person.url, { cache: "no-store" });
        if (!res.ok) throw new Error(`person download ${res.status}`);
        blob = await res.blob();
      }
      next.push({ id: person.id, name: person.name, blob });
    }
    for (const id of this.images.keys()) {
      if (!next.some((p) => p.id === id) && !this.registered.some((f) => f.id === id)) {
        this.images.get(id)?.close?.();
        this.images.delete(id);
      }
    }
    this.people = next;
    await kv.set(PEOPLE_KEY, next);
  }

  async personImage(person) {
    if (!this.images.has(person.id)) this.images.set(person.id, await createImageBitmap(person.blob));
    return this.images.get(person.id);
  }

  async imageFor(frame) {
    if (frame.kind !== "png") return null;
    if (!this.images.has(frame.id)) this.images.set(frame.id, await createImageBitmap(frame.blob));
    const image = this.images.get(frame.id);
    // Read once per frame id, not once per decode: the previews warm the image
    // cache long before anyone picks the frame to shoot with.
    if (!this.slots.has(frame.id)) this.slots.set(frame.id, readSlots(image, frame.layout));
    frame.slots ??= this.slots.get(frame.id) ?? undefined;
    return image;
  }

  changed() {
    this.dispatchEvent(new Event("change"));
  }
}
