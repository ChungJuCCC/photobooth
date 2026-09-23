// Background upload queue. Every finished shoot is stored on the device
// first, then uploaded when the network allows. Survives app restarts.

import { queueStore } from "./db.js";

const RETRY_MS = 30_000;
const GIVE_UP_MS = 24 * 60 * 60 * 1000;

// Errors that will never succeed on retry; the item is dropped.
const PERMANENT = new Set(["session_conflict", "session_expired", "invalid_id", "invalid_device", "invalid_video_type", "invalid_body"]);

export class UploadQueue extends EventTarget {
  constructor(api, deviceId) {
    super();
    this.api = api;
    this.deviceId = deviceId;
    this.running = false;
    this.pending = 0;
    this.status = new Map(); // session id → "waiting" | "uploading" | "retrying" | "done"
  }

  start() {
    addEventListener("online", () => this.process());
    setInterval(() => this.process(), RETRY_MS);
    return this.process();
  }

  async add(item) {
    await queueStore.put({ ...item, attempts: 0, lastError: null });
    this.setStatus(item.id, "waiting");
    this.process();
  }

  async process() {
    if (this.running) return;
    this.running = true;
    try {
      const items = await queueStore.all();
      this.pending = items.length;
      this.emit();

      for (const item of items) {
        if (Date.now() - item.createdAt > GIVE_UP_MS) {
          await queueStore.delete(item.id);
          continue;
        }
        this.setStatus(item.id, "uploading");
        try {
          await this.upload(item);
          await queueStore.delete(item.id);
          this.setStatus(item.id, "done");
        } catch (err) {
          if (PERMANENT.has(err?.code)) {
            console.warn("dropping upload", item.id, err.code);
            await queueStore.delete(item.id);
            continue;
          }
          await queueStore.put({ ...item, attempts: item.attempts + 1, lastError: String(err?.code ?? err) });
          this.setStatus(item.id, "retrying");
          break; // network is probably down; try the rest on the next round
        }
      }
    } finally {
      this.running = false; // before any await, so a storage error can't wedge the queue
      this.pending = (await queueStore.all().catch(() => [])).length;
      this.emit();
    }
  }

  async upload(item) {
    const ticket = await this.api.createUpload({
      id: item.id,
      deviceId: this.deviceId,
      frameId: item.frameId,
      videoType: item.video ? item.videoType : null,
    });
    if (ticket.status === "already_uploaded") return;

    await this.api.putSigned(ticket.photo.signedUrl, item.photo, "image/jpeg");
    if (ticket.video && item.video) await this.api.putSigned(ticket.video.signedUrl, item.video, item.videoType);
    await this.api.completeUpload({ id: item.id, deviceId: this.deviceId });
  }

  setStatus(id, status) {
    this.status.set(id, status);
    this.emit();
  }

  emit() {
    this.dispatchEvent(new Event("change"));
  }
}
