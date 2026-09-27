// The finished four-cut, moving.
//
// While the booth shoots, a rolling buffer keeps the last couple of seconds of
// camera frames at slot size. Each shutter claims that buffer as the clip for
// that take. Once the guests pick their four, every slot replays its own clip
// inside the frame, so the video is the print they are holding rather than a
// separate recording of the booth.
//
// Preferred path is WebCodecs into MP4 (iPhones can play and save it); older
// WebViews fall back to MediaRecorder on a canvas.

import { ArrayBufferTarget, Muxer } from "../vendor/mp4-muxer.mjs";
import { centerCrop, drawMirrored } from "./camera.js";
import { paintPrint } from "./compose.js";
import { LAYOUTS, PHOTO_RATIO } from "./layouts.js";

export const CLIP_SAMPLE_MS = 100; // 10 fps captured, replayed at 30 fps → 3× speed
// Forward and back at 30 fps, this lands a hair under 2.5 seconds per loop.
export const CLIP_FRAMES = 38;

// Frames are kept as JPEGs, not as bitmaps: at this size 38 frames × 6 takes
// would be ~90 MB of raw pixels, which a cheap tablet will not survive. They
// are decoded one at a time while encoding instead.
const CLIP_WIDTH = 480;
const CLIP_HEIGHT = Math.round(CLIP_WIDTH / PHOTO_RATIO);
const CLIP_QUALITY = 0.82;

const OUTPUT_FPS = 30;
const FRAME_US = Math.round(1_000_000 / OUTPUT_FPS);
const BITRATE = 4_000_000;

// Best size first. H.264 level 4.0 allows the full sheet; level 3.1 caps out
// near 3600 macroblocks, so older encoders get the smaller one. Every side is
// even for 4:2:0 chroma.
const OUTPUT_SIZES = {
  vertical: [
    { width: 720, height: 2158, codec: "avc1.420028" },
    { width: 544, height: 1632, codec: "avc1.42001f" },
  ],
  grid: [
    { width: 1080, height: 1920, codec: "avc1.420028" },
    { width: 712, height: 1264, codec: "avc1.42001f" },
  ],
};

function encoderConfig({ width, height, codec }) {
  return {
    codec,
    width,
    height,
    bitrate: BITRATE,
    framerate: OUTPUT_FPS,
    avc: { format: "avc" },
  };
}

async function pickSize(layout) {
  const options = OUTPUT_SIZES[layout] ?? OUTPUT_SIZES.vertical;
  if (typeof VideoEncoder === "undefined") return options[options.length - 1];
  for (const size of options) {
    try {
      if ((await VideoEncoder.isConfigSupported(encoderConfig(size))).supported === true) return size;
    } catch {
      // try the next one down
    }
  }
  return options[options.length - 1];
}

// Forward then back, so the clip loops without a jump.
export function pingPong(length) {
  const order = [];
  for (let i = 0; i < length; i++) order.push(i);
  for (let i = length - 2; i > 0; i--) order.push(i);
  return order;
}

// ── recording ─────────────────────────────────────────────────────────

export class ClipRecorder {
  constructor(video) {
    this.video = video;
    this.canvas = document.createElement("canvas");
    this.canvas.width = CLIP_WIDTH;
    this.canvas.height = CLIP_HEIGHT;
    this.ctx = this.canvas.getContext("2d");
    this.ring = [];
    this.clips = [];
    this.busy = false;
    this.timer = 0;
  }

  start() {
    if (!this.timer) this.timer = setInterval(() => void this.sample(), CLIP_SAMPLE_MS);
  }

  async sample() {
    const { videoWidth: vw, videoHeight: vh } = this.video;
    if (this.busy || !this.timer || !vw) return;
    this.busy = true;
    try {
      drawMirrored(this.ctx, this.video, centerCrop(vw, vh, PHOTO_RATIO), CLIP_WIDTH, CLIP_HEIGHT);
      const frame = await new Promise((r) => this.canvas.toBlob(r, "image/jpeg", CLIP_QUALITY));
      if (frame) this.ring.push(frame);
      while (this.ring.length > CLIP_FRAMES) this.ring.shift();
    } catch {
      // A dropped sample only makes the clip a frame shorter.
    } finally {
      this.busy = false;
    }
  }

  // Called at the shutter: the buffer becomes this take's clip, ending on the
  // moment that was photographed.
  markShot(index) {
    this.clips[index] = this.ring;
    this.ring = [];
  }

  stop() {
    clearInterval(this.timer);
    this.timer = 0;
    this.ring = [];
  }

  // Frees every take the guests did not choose.
  keepOnly(indexes) {
    this.clips.forEach((clip, i) => {
      if (!clip || indexes.includes(i)) return;
      this.clips[i] = null;
    });
  }

  release() {
    this.stop();
    this.clips = [];
    this.canvas.width = this.canvas.height = 0;
  }

  clipsFor(indexes) {
    const clips = indexes.map((i) => this.clips[i]);
    return clips.every((clip) => clip && clip.length >= 2) ? clips : null;
  }
}

// ── rendering ─────────────────────────────────────────────────────────

async function drawSequenceFrame(ctx, { frame, frameImage, clips, when, order, step, scale }) {
  const at = order[step % order.length];
  const sources = await Promise.all(
    clips.map((clip) => createImageBitmap(clip[Math.min(at, clip.length - 1)]))
  );
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  paintPrint(ctx, frame, sources, frameImage, when);
  for (const source of sources) source.close();
}

async function encodeWithWebCodecs({ frame, frameImage, clips, when, size }) {
  const config = encoderConfig(size);
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return null;
  try {
    if ((await VideoEncoder.isConfigSupported(config)).supported !== true) return null;
  } catch {
    return null;
  }

  const layout = LAYOUTS[frame.layout];
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  const scale = size.width / layout.width;
  const order = pingPong(Math.min(...clips.map((c) => c.length)));

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width: size.width, height: size.height, frameRate: OUTPUT_FPS },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });

  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (failure = e),
  });
  encoder.configure(config);

  try {
    for (let step = 0; step < order.length && !failure; step++) {
      await drawSequenceFrame(ctx, { frame, frameImage, clips, when, order, step, scale });
      const videoFrame = new VideoFrame(canvas, { timestamp: step * FRAME_US, duration: FRAME_US });
      try {
        encoder.encode(videoFrame, { keyFrame: step === 0 });
      } finally {
        videoFrame.close();
      }
      if (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
    }
    if (failure) return null;
    await encoder.flush();
    if (failure) return null;
    muxer.finalize();
    const blob = new Blob([target.buffer], { type: "video/mp4" });
    return blob.size ? { blob, type: "video/mp4" } : null;
  } finally {
    if (encoder.state !== "closed") encoder.close();
    canvas.width = canvas.height = 0;
  }
}

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

async function encodeWithRecorder({ frame, frameImage, clips, when, size }) {
  const mime = recorderType();
  if (!mime) return null;

  const layout = LAYOUTS[frame.layout];
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  const scale = size.width / layout.width;
  const order = pingPong(Math.min(...clips.map((c) => c.length)));

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
  const total = order.length; // one full turn; the player loops it
  const t0 = performance.now();
  try {
    for (let step = 0; step < total; step++) {
      await drawSequenceFrame(ctx, { frame, frameImage, clips, when, order, step, scale });
      track.requestFrame?.();
      const due = t0 + ((step + 1) * 1000) / OUTPUT_FPS - performance.now();
      if (due > 0) await new Promise((r) => setTimeout(r, due));
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

// clips: four arrays of ImageBitmaps, in slot order.
export async function renderMotionPrint({ frame, frameImage, clips, when = new Date() }) {
  if (!clips?.length || clips.some((clip) => !clip?.length)) return null;
  const size = await pickSize(frame.layout);
  const args = { frame, frameImage, clips, when, size };
  try {
    const mp4 = await encodeWithWebCodecs(args);
    if (mp4) return mp4;
  } catch (err) {
    console.warn("WebCodecs motion print failed, using recorder", err);
  }
  return encodeWithRecorder(args);
}
