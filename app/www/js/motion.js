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
import { centerCrop, drawMirrored, drawPerson } from "./camera.js";
import { paintPrint } from "./compose.js";
import { captureSize, LAYOUTS, PHOTO_RATIO } from "./layouts.js";

// Sampling rides the camera's own frames where the browser allows it, so the
// film is as smooth as the tablet can manage rather than as smooth as a timer
// guesses. The floor keeps a fast camera from filling memory.
export const CLIP_SAMPLE_MS = 45; // at most ~22 frames a second
// A cut keeps everything from the previous shutter up to its own, so the film
// runs for as long as the shoot did. Frames are timestamped as they are taken,
// so a tablet that samples slower produces a jerkier film rather than a
// sped-up one — it always runs at life speed.
export const CLIP_WINDOW_MS = 8000; // the longest a countdown can reasonably be
export const CLIP_MAX_FRAMES = 200; // memory guard if sampling runs fast

// Frames are kept as JPEGs, not as bitmaps: at this size 38 frames × 6 takes
// would be ~90 MB of raw pixels, which a cheap tablet will not survive. They
// are decoded one at a time while encoding instead.
// Smaller and slightly softer than before: a cheaper frame is a frame the
// tablet actually manages to take, and more frames beat sharper ones here.
const CLIP_LONG_SIDE = 540;
const CLIP_QUALITY = 0.78;
const CLIP_IN_FLIGHT = 2; // encodes allowed to overlap

const NOMINAL_FPS = 15; // what the container advertises; real timing per frame
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
    framerate: NOMINAL_FPS,
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

// One pass through the take, lasting exactly as long as the shooting did.
//
// Frames rarely arrive evenly — a tablet that stalls for a moment leaves a
// long gap next to short ones, and that unevenness reads as stutter even when
// the average rate is fine. Gaps are pulled towards the middle and then
// rescaled so the clip still ends where it really ended.
export function playOnce(times) {
  const raw = [];
  for (let i = 0; i < times.length - 1; i++) raw.push(Math.max(1, times[i + 1] - times[i]));
  if (!raw.length) return times.map((_, i) => ({ index: i, ms: CLIP_SAMPLE_MS }));

  const sorted = [...raw].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const evened = raw.map((gap) => Math.min(Math.max(gap, median * 0.6), median * 1.8));

  const span = raw.reduce((a, b) => a + b, 0);
  const total = evened.reduce((a, b) => a + b, 0);
  const scale = span / total;
  const gaps = evened.map((gap) => gap * scale);

  const average = span / raw.length;
  return times.map((_, i) => ({ index: i, ms: gaps[i] ?? average }));
}

// ── recording ─────────────────────────────────────────────────────────

export class ClipRecorder {
  constructor(video, ratio = PHOTO_RATIO) {
    this.video = video;
    this.ratio = ratio;
    this.person = null; // whoever is posing in the take being recorded
    const { width, height } = captureSize(ratio, CLIP_LONG_SIDE);
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext("2d");
    this.ring = [];
    this.clips = [];
    this.inFlight = 0;
    this.lastAt = 0;
    this.running = false;
    this.timer = 0; // only used where the camera cannot drive the sampling
  }

  start() {
    if (this.running) return;
    this.running = true;

    // Chrome and Safari can call back on every camera frame; everything else
    // falls back to a timer.
    if (typeof this.video.requestVideoFrameCallback === "function") {
      const onFrame = () => {
        if (!this.running) return;
        this.sample();
        this.video.requestVideoFrameCallback(onFrame);
      };
      this.video.requestVideoFrameCallback(onFrame);
    } else {
      this.timer = setInterval(() => this.sample(), CLIP_SAMPLE_MS);
    }
  }

  sample() {
    const { videoWidth: vw, videoHeight: vh } = this.video;
    const now = performance.now();
    // One encode may still be in the air; two is the most worth queueing, and
    // frames closer together than the floor are thrown away.
    if (!this.running || !vw || this.inFlight >= CLIP_IN_FLIGHT || now - this.lastAt < CLIP_SAMPLE_MS) return;
    this.lastAt = now;

    drawMirrored(this.ctx, this.video, centerCrop(vw, vh, this.ratio), this.canvas.width, this.canvas.height);
    if (this.person) drawPerson(this.ctx, this.person, this.canvas.width, this.canvas.height);

    // Frames are stamped when they were taken, not when the encoder caught up,
    // so a slow encode shows as a gap rather than as a speed change.
    const ring = this.ring;
    this.inFlight++;
    this.canvas.toBlob(
      (blob) => {
        this.inFlight--;
        if (!blob || ring !== this.ring) return; // the shutter already took it
        ring.push({ blob, at: now });
        const cutoff = performance.now() - CLIP_WINDOW_MS;
        while (ring.length > 1 && (ring[0].at < cutoff || ring.length > CLIP_MAX_FRAMES)) ring.shift();
      },
      "image/jpeg",
      CLIP_QUALITY,
    );
  }

  // Called at the shutter: the buffer becomes this take's clip, ending on the
  // moment that was photographed.
  markShot(index) {
    this.clips[index] = this.ring;
    this.ring = [];
  }

  stop() {
    this.running = false;
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
    return clips.every((clip) => clip && clip.length >= 3) ? clips : null;
  }
}

// ── rendering ─────────────────────────────────────────────────────────

async function drawSequenceFrame(ctx, { frame, frameImage, clips, when, index, scale }) {
  const sources = await Promise.all(
    clips.map((clip) => createImageBitmap(clip[Math.min(index, clip.length - 1)].blob))
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
  const steps = timeline(clips);

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width: size.width, height: size.height, frameRate: NOMINAL_FPS },
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
    let at = 0; // microseconds into the clip
    for (let step = 0; step < steps.length && !failure; step++) {
      const { index, ms } = steps[step];
      await drawSequenceFrame(ctx, { frame, frameImage, clips, when, index, scale });
      const duration = Math.round(ms * 1000);
      const videoFrame = new VideoFrame(canvas, { timestamp: at, duration });
      at += duration;
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
  const steps = timeline(clips);

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
  let due = 0; // milliseconds into the clip
  try {
    for (const { index, ms } of steps) {
      await drawSequenceFrame(ctx, { frame, frameImage, clips, when, index, scale });
      track.requestFrame?.();
      due += ms;
      const wait = t0 + due - performance.now();
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

// The shared play order: every cut was sampled by the same recorder, so the
// first one's timing drives all four.
function timeline(clips) {
  // The shortest take sets the length. Running past it would leave the other
  // cuts frozen on their last frame, which looks broken; a tail nobody saw
  // being cut does not.
  const length = Math.min(...clips.map((c) => c.length));
  const driver = clips.find((c) => c.length === length) ?? clips[0];
  return playOnce(driver.map((f) => f.at));
}

// clips: four arrays of captured frames, in slot order.
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
