// Sped-up video of the whole shoot.
//
// Preferred path (WebCodecs): each sampled camera frame goes straight into the
// device's H.264 encoder with a 30 fps timestamp, so 10 fps of real time
// becomes 3× speed with no second pass and no per-frame JPEG work. The result
// is always MP4, which iPhones can play and save.
//
// Fallback (older WebViews): keep small JPEG frames, then replay them into a
// canvas recorded by MediaRecorder.

import { ArrayBufferTarget, Muxer } from "../vendor/mp4-muxer.mjs";
import {
  centerCrop,
  drawMirrored,
  TIMELAPSE_HEIGHT as HEIGHT,
  TIMELAPSE_MAX_FRAMES as MAX_FRAMES,
  TIMELAPSE_SAMPLE_MS as SAMPLE_MS,
  TIMELAPSE_WIDTH as WIDTH,
  TimelapseSampler,
} from "./camera.js";

const OUTPUT_FPS = 30;
const FRAME_US = Math.round(1_000_000 / OUTPUT_FPS);
const BITRATE = 2_000_000; // ≈1.5 MB for 6 seconds
const MIN_FRAMES = 10;

const ENCODER_CONFIG = {
  codec: "avc1.42001f", // H.264 baseline 3.1: plays everywhere, fits 720×960
  width: WIDTH,
  height: HEIGHT,
  bitrate: BITRATE,
  framerate: OUTPUT_FPS,
  avc: { format: "avc" },
};

function drawCaption(ctx, caption) {
  if (!caption) return;
  ctx.save();
  ctx.font = `600 28px "Wanted Sans Variable", sans-serif`;
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(0,0,0,.35)";
  ctx.fillText(caption, WIDTH / 2 + 1, HEIGHT - 39);
  ctx.fillStyle = "#FFFFFF";
  ctx.fillText(caption, WIDTH / 2, HEIGHT - 40);
  ctx.restore();
}

async function webCodecsAvailable() {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return false;
  try {
    return (await VideoEncoder.isConfigSupported(ENCODER_CONFIG)).supported === true;
  } catch {
    return false;
  }
}

class WebCodecsTimelapse {
  constructor(video, caption) {
    this.video = video;
    this.caption = caption;
    this.canvas = document.createElement("canvas");
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    this.ctx = this.canvas.getContext("2d");
    this.count = 0;
    this.error = null;
    this.target = new ArrayBufferTarget();
    this.muxer = new Muxer({
      target: this.target,
      video: { codec: "avc", width: WIDTH, height: HEIGHT, frameRate: OUTPUT_FPS },
      fastStart: "in-memory",
      firstTimestampBehavior: "offset",
    });
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => this.muxer.addVideoChunk(chunk, meta),
      error: (e) => (this.error = e),
    });
    this.encoder.configure(ENCODER_CONFIG);
  }

  start() {
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
  }

  sample() {
    const { videoWidth: vw, videoHeight: vh } = this.video;
    if (this.error || !vw || this.count >= MAX_FRAMES) return;
    // A slow encoder skips a frame instead of buffering the whole shoot in memory.
    if (this.encoder.encodeQueueSize > 12) return;

    drawMirrored(this.ctx, this.video, centerCrop(vw, vh, WIDTH / HEIGHT), WIDTH, HEIGHT);
    drawCaption(this.ctx, this.caption);
    const frame = new VideoFrame(this.canvas, { timestamp: this.count * FRAME_US, duration: FRAME_US });
    try {
      this.encoder.encode(frame, { keyFrame: this.count % OUTPUT_FPS === 0 });
      this.count++;
    } finally {
      frame.close();
    }
  }

  // Stops sampling immediately (before the first await), so the caller can
  // turn the camera off right after calling this.
  async finish() {
    clearInterval(this.timer);
    try {
      if (this.count < MIN_FRAMES || this.error) return null;
      await this.encoder.flush();
      if (this.error) return null;
      this.muxer.finalize();
      const blob = new Blob([this.target.buffer], { type: "video/mp4" });
      return blob.size ? { blob, type: "video/mp4" } : null;
    } finally {
      if (this.encoder.state !== "closed") this.encoder.close();
      this.canvas.width = this.canvas.height = 0;
    }
  }
}

// ── fallback ──────────────────────────────────────────────────────────

const RECORDER_TYPES = [
  "video/mp4;codecs=avc1.42E01F",
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

function recorderType() {
  if (typeof MediaRecorder === "undefined" || !HTMLCanvasElement.prototype.captureStream) return null;
  return RECORDER_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

class RecorderTimelapse {
  constructor(video, caption) {
    this.sampler = new TimelapseSampler(video);
    this.caption = caption;
  }

  start() {
    this.sampler.start();
  }

  async finish() {
    const frames = this.sampler.stop();
    const mime = recorderType();
    if (!mime || frames.length < MIN_FRAMES) return null;

    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: BITRATE });
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = (e) => reject(e.error ?? new Error("recorder error"));
    });

    recorder.start(1000);
    const t0 = performance.now();
    try {
      for (let i = 0; i < frames.length; i++) {
        const bitmap = await createImageBitmap(frames[i]);
        ctx.drawImage(bitmap, 0, 0, WIDTH, HEIGHT);
        bitmap.close();
        drawCaption(ctx, this.caption);
        track.requestFrame?.();
        const wait = t0 + ((i + 1) * 1000) / OUTPUT_FPS - performance.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      recorder.stop();
      await Promise.race([stopped, new Promise((_, r) => setTimeout(() => r(new Error("encode timeout")), 15_000))]);
    } finally {
      track.stop();
      canvas.width = canvas.height = 0;
    }
    const type = mime.split(";")[0]; // the storage bucket rejects codec parameters
    const blob = new Blob(chunks, { type });
    return blob.size ? { blob, type } : null;
  }
}

// ── public ────────────────────────────────────────────────────────────

let webCodecsCheck = null;

export async function createTimelapse(video, { caption = "" } = {}) {
  webCodecsCheck ??= webCodecsAvailable();
  if (await webCodecsCheck) {
    try {
      return new WebCodecsTimelapse(video, caption);
    } catch (err) {
      console.warn("WebCodecs timelapse unavailable, using fallback", err);
    }
  }
  return new RecorderTimelapse(video, caption);
}
