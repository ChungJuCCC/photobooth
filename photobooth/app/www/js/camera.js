// Front camera, still photos, and timelapse frame sampling.

import { PHOTO_RATIO } from "./layouts.js";

const PHOTO_WIDTH = 998;
const PHOTO_HEIGHT = Math.round(PHOTO_WIDTH / PHOTO_RATIO);

export const TIMELAPSE_WIDTH = 720;
export const TIMELAPSE_HEIGHT = 960;
export const TIMELAPSE_SAMPLE_MS = 100; // 10 fps captured, played at 30 fps → 3× speed
export const TIMELAPSE_MAX_FRAMES = 240; // 8 seconds of output at most

export class CameraError extends Error {
  constructor(kind, cause) {
    super(kind);
    this.kind = kind; // "denied" | "missing" | "busy" | "unknown"
    this.cause = cause;
  }
}

// Largest centered crop of the source with the given aspect ratio.
export function centerCrop(sw, sh, ratio) {
  if (sw / sh > ratio) {
    const w = sh * ratio;
    return { sx: (sw - w) / 2, sy: 0, sw: w, sh };
  }
  const h = sw / ratio;
  return { sx: 0, sy: (sh - h) / 2, sw, sh: h };
}

export function drawMirrored(ctx, video, crop, width, height) {
  ctx.save();
  ctx.translate(width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, width, height);
  ctx.restore();
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), type, quality)
  );
}

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
  }

  async start() {
    if (this.stream) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1920 }, height: { ideal: 1920 }, frameRate: { ideal: 30 } },
        audio: false,
      });
    } catch (err) {
      const kind = err?.name === "NotAllowedError" ? "denied"
        : err?.name === "NotFoundError" || err?.name === "OverconstrainedError" ? "missing"
        : err?.name === "NotReadableError" ? "busy"
        : "unknown";
      throw new CameraError(kind, err);
    }
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    await this.waitForFrames();
  }

  async waitForFrames(timeoutMs = 4000) {
    const started = performance.now();
    while (!this.video.videoWidth && performance.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!this.video.videoWidth) throw new CameraError("busy");
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  // One mirrored still, cropped to the photo slot proportions.
  async takePhoto() {
    const { videoWidth: vw, videoHeight: vh } = this.video;
    if (!vw || !vh) throw new CameraError("busy");
    const canvas = document.createElement("canvas");
    canvas.width = PHOTO_WIDTH;
    canvas.height = PHOTO_HEIGHT;
    drawMirrored(canvas.getContext("2d"), this.video, centerCrop(vw, vh, PHOTO_RATIO), PHOTO_WIDTH, PHOTO_HEIGHT);
    const blob = await toBlob(canvas, "image/jpeg", 0.92);
    canvas.width = canvas.height = 0;
    const bitmap = await createImageBitmap(blob);
    return { blob, bitmap, url: URL.createObjectURL(blob) };
  }
}

// Grabs small JPEG frames while the guests are being photographed.
export class TimelapseSampler {
  constructor(video) {
    this.video = video;
    this.frames = [];
    this.timer = 0;
    this.busy = false;
    this.canvas = document.createElement("canvas");
    this.canvas.width = TIMELAPSE_WIDTH;
    this.canvas.height = TIMELAPSE_HEIGHT;
  }

  start() {
    this.frames = [];
    this.timer = setInterval(() => this.sample(), TIMELAPSE_SAMPLE_MS);
  }

  async sample() {
    const { videoWidth: vw, videoHeight: vh } = this.video;
    // Skip a tick instead of piling up encodes on a slow tablet.
    if (this.busy || !vw || this.frames.length >= TIMELAPSE_MAX_FRAMES) return;
    this.busy = true;
    try {
      const ctx = this.canvas.getContext("2d");
      drawMirrored(ctx, this.video, centerCrop(vw, vh, TIMELAPSE_WIDTH / TIMELAPSE_HEIGHT), TIMELAPSE_WIDTH, TIMELAPSE_HEIGHT);
      this.frames.push(await toBlob(this.canvas, "image/jpeg", 0.72));
    } catch {
      // a dropped frame is fine
    } finally {
      this.busy = false;
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = 0;
    const frames = this.frames;
    this.frames = [];
    return frames;
  }
}
