// Booth flow: frames → shoot 6 → pick 4 → result + QR.

import { createApi } from "./api.js";
import { Camera, CameraError } from "./camera.js";
import { canvasToBlob, renderComposite } from "./compose.js";
import { deviceId as loadDeviceId } from "./db.js";
import { FrameLibrary } from "./frames.js";
import { UploadQueue } from "./queue.js";
import { ClipRecorder, renderMotionPrint } from "./motion.js";
import { frameRatio, LAYOUTS } from "./layouts.js";
import { setupAdmin } from "./admin.js";
import qrcode from "../vendor/qrcode.mjs";

const config = window.BOOTH_CONFIG ?? {};

const SHOTS = 6;
const PICKS = 4;
const TICK_MS = 1000;
const COUNTDOWN_TICKS = 4; // plus one for the very first shot, which needs settling time
const IDLE_MS = 60_000;
const IDLE_WARN_MS = 15_000;
// A frame registered on one tablet should appear on the others while the
// event is still running, so the waiting screen polls rather than sitting on
// a cached list. It also keeps a free Supabase project awake.
const FRAME_REFRESH_MS = 5 * 60 * 1000;
const FRAME_STALE_MS = 60 * 1000;

const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const api = createApi(config);
const camera = new Camera($("camera-video"));

const state = {
  screen: "frames",
  frame: null,
  sessionId: null,
  shots: [],
  picked: [],
  clips: null,
  videoPromise: null,
  lastTouch: Date.now(),
  shooting: false,
  finishing: false,
};

let library;
let queue;

// ── screens ─────────────────────────────────────────────────────────────

function show(name) {
  for (const el of document.querySelectorAll(".screen")) {
    const active = el.dataset.screen === name;
    el.hidden = !active;
    if (active) {
      el.classList.remove("entering");
      void el.offsetWidth;
      el.classList.add("entering");
    }
  }
  state.screen = name;
  state.lastTouch = Date.now();
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), 2600);
}

function goHome() {
  releaseShots();
  state.clips?.release();
  state.clips = null;
  state.frame = null;
  state.sessionId = null;
  state.videoPromise = null;
  show("frames");
  if (Date.now() - library.lastRefresh > FRAME_STALE_MS) library.refresh().catch(() => {});
}

function releaseShots() {
  for (const shot of state.shots) {
    URL.revokeObjectURL(shot.url);
    shot.bitmap.close?.();
  }
  state.shots = [];
  state.picked = [];
}

// ── 1. frame list ───────────────────────────────────────────────────────

let frameRenderToken = 0;

async function renderFrameRows() {
  // A refresh can land while a previous render is still awaiting images.
  const token = ++frameRenderToken;
  for (const row of document.querySelectorAll(".frame-row")) {
    const layout = row.dataset.layout;
    row.replaceChildren();
    for (const frame of library.byLayout(layout)) {
      if (token !== frameRenderToken) return;
      const card = document.createElement("button");
      card.type = "button";
      card.className = "frame-card";
      card.setAttribute("aria-label", `${frame.name} 프레임으로 촬영 시작`);
      const canvas = document.createElement("canvas");
      const label = document.createElement("span");
      label.textContent = frame.name;
      card.append(canvas, label);
      card.addEventListener("click", () => startSession(frame));
      row.append(card);

      const image = await library.imageFor(frame).catch(() => null);
      renderComposite(canvas, frame, [], image, { placeholder: "#E9E9E6", scale: 0.35 });
    }
  }
}

function renderQueueNote() {
  const note = $("queue-note");
  note.hidden = queue.pending === 0;
  note.textContent = `아직 올라가지 않은 사진 ${queue.pending}건이 있어요. 인터넷에 연결되면 자동으로 올라가요.`;
}

// ── 2. shooting ─────────────────────────────────────────────────────────

async function startSession(frame) {
  if (state.shooting) return;
  state.shooting = true;
  releaseShots();
  state.frame = frame;
  state.sessionId = crypto.randomUUID();

  const strip = $("shot-strip");
  strip.replaceChildren(...Array.from({ length: SHOTS }, () => document.createElement("li")));
  $("shot-counter").textContent = "";
  $("shoot-title").textContent = "카메라를 봐주세요";
  show("shoot");

  try {
    await camera.start();
  } catch (err) {
    state.shooting = false;
    return showCameraError(err);
  }

  state.clips?.release();
  state.clips = null;
  // Viewfinder, takes and clips all take the shape of the chosen frame's cuts,
  // which for a registered PNG are read from its own transparency.
  const frameImage = await library.imageFor(state.frame).catch(() => null);
  const ratio = frameRatio(state.frame);
  document.documentElement.style.setProperty("--shot-ratio", String(ratio));
  let clips = null;
  try {
    clips = new ClipRecorder($("camera-video"), ratio);
    clips.start();
    await wait(1500);

    for (let i = 0; i < SHOTS; i++) {
      $("shot-counter").textContent = `${i + 1} / ${SHOTS}`;
      $("shoot-title").textContent = i === 0 ? "자세를 잡아주세요" : ["좋아요, 다음 포즈", "표정을 바꿔볼까요", "한 번 더", "거의 다 왔어요", "마지막 한 장"][i - 1];
      strip.children[i].classList.add("current");
      showCutArtwork(state.frame, frameImage, i);

      for (let n = i === 0 ? COUNTDOWN_TICKS + 1 : COUNTDOWN_TICKS; n >= 1; n--) {
        const el = $("countdown");
        el.textContent = n;
        el.classList.remove("tick");
        void el.offsetWidth;
        el.classList.add("tick");
        await wait(TICK_MS);
      }

      const flash = $("flash");
      flash.classList.remove("fire");
      void flash.offsetWidth;
      flash.classList.add("fire");

      const shot = await camera.takePhoto(ratio);
      clips.markShot(i);
      state.shots.push(shot);
      const img = document.createElement("img");
      img.src = shot.url;
      img.alt = "";
      strip.children[i].classList.remove("current");
      strip.children[i].replaceChildren(img);
      await wait(350);
    }

    // Sampling stops here so the camera can go off; the clips wait in memory
    // until the guests have picked the four that go in the frame.
    clips.stop();
    state.clips = clips;
    hideCutArtwork();
    camera.stop();

    state.picked = [];
    renderPick();
    show("pick");
  } catch (err) {
    clips?.release();
    state.clips = null;
    hideCutArtwork();
    camera.stop();
    showCameraError(err);
  } finally {
    state.shooting = false;
  }
}

// Shows the part of the frame that will cover this cut, over the live camera.
// With six takes and four cuts the last two repeat the first two: the cut a
// photo ends up in is decided later, by the order the guests pick them.
function showCutArtwork(frame, image, shotIndex) {
  const canvas = $("camera-overlay");
  // Only frames registered as having someone in their cuts show them here.
  const slots = frame.kind === "png" && frame.hasPeople && frame.slots ? frame.slots : null;
  const slot = slots?.[shotIndex % slots.length];
  if (!image || !slot) return hideCutArtwork();

  // A frame may be exported at any multiple of the layout size.
  const scale = image.width / LAYOUTS[frame.layout].width;
  canvas.width = slot.w;
  canvas.height = slot.h;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, slot.w, slot.h);
  ctx.drawImage(image, slot.x * scale, slot.y * scale, slot.w * scale, slot.h * scale, 0, 0, slot.w, slot.h);
  canvas.hidden = false;
}

function hideCutArtwork() {
  const canvas = $("camera-overlay");
  canvas.hidden = true;
  canvas.width = canvas.height = 0;
}

function showCameraError(err) {
  const kind = err instanceof CameraError ? err.kind : "unknown";
  $("camera-error-text").textContent = {
    denied: "카메라 권한이 꺼져 있어요. 태블릿 설정 > 애플리케이션 > 포토부스 > 권한에서 카메라를 허용해주세요.",
    missing: "전면 카메라를 찾지 못했어요.",
    busy: "다른 앱이 카메라를 쓰고 있어요. 다른 앱을 닫고 다시 시도해주세요.",
    unknown: "잠시 후 다시 시도해주세요. 계속 안 되면 앱을 껐다 켜주세요.",
  }[kind];
  show("camera-error");
}

// ── 3. picking ──────────────────────────────────────────────────────────

function renderPick() {
  const grid = $("pick-grid");
  grid.replaceChildren();
  state.shots.forEach((shot, index) => {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "pick-cell";
    cell.setAttribute("aria-label", `${index + 1}번째 사진`);
    const img = document.createElement("img");
    img.src = shot.url;
    img.alt = "";
    cell.append(img);
    cell.addEventListener("click", () => togglePick(index));
    grid.append(cell);
  });
  updatePick();
}

function togglePick(index) {
  const at = state.picked.indexOf(index);
  const hint = $("pick-hint");
  if (at >= 0) {
    state.picked.splice(at, 1);
  } else if (state.picked.length < PICKS) {
    state.picked.push(index);
  } else {
    hint.textContent = "이미 4장을 골랐어요. 빼고 싶은 사진을 먼저 눌러주세요";
    hint.classList.add("pick-hint-warn");
    return;
  }
  hint.textContent = "누른 순서대로 프레임 칸에 들어가요";
  hint.classList.remove("pick-hint-warn");
  updatePick();
}

async function updatePick() {
  const cells = $("pick-grid").children;
  for (let i = 0; i < cells.length; i++) {
    const order = state.picked.indexOf(i);
    const cell = cells[i];
    cell.classList.toggle("selected", order >= 0);
    cell.setAttribute("aria-pressed", String(order >= 0));
    cell.querySelector(".order")?.remove();
    if (order >= 0) {
      const badge = document.createElement("span");
      badge.className = "order";
      badge.textContent = order + 1;
      cell.append(badge);
    }
  }
  $("pick-grid").classList.toggle("full", state.picked.length === PICKS);
  $("pick-confirm").disabled = state.picked.length !== PICKS;

  const image = await library.imageFor(state.frame).catch(() => null);
  renderComposite($("pick-preview"), state.frame, state.picked.map((i) => state.shots[i].bitmap), image, {
    placeholder: "#E9E9E6",
    scale: 0.3,
  });
}

// ── 4. result ───────────────────────────────────────────────────────────

function guestUrl(id) {
  return `${config.guestPageUrl}?id=${id}`;
}

function drawQr(canvas, text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const modules = qr.getModuleCount();
  const quiet = 2;
  const size = modules + quiet * 2;
  const scale = 8;
  canvas.width = canvas.height = size * scale;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000000";
  for (let r = 0; r < modules; r++) {
    for (let c = 0; c < modules; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
}

async function finishSession() {
  if (state.finishing) return;
  state.finishing = true;
  $("pick-confirm").disabled = true;

  // Capture everything this session needs; the guest may leave the result
  // screen before the video is ready, and the upload must still happen.
  const id = state.sessionId;
  const frame = state.frame;
  const picked = [...state.picked];

  try {
    const canvas = $("result-canvas");
    const image = await library.imageFor(frame).catch(() => null);
    renderComposite(canvas, frame, picked.map((i) => state.shots[i].bitmap), image);

    // The clips belong to this render from here on, so going home (or an idle
    // timeout) can't free the frames out from under the encoder.
    const recorder = state.clips;
    state.clips = null;
    recorder?.keepOnly(picked);
    const clips = recorder?.clipsFor(picked) ?? null;
    const videoPromise = clips
      ? renderMotionPrint({ frame, frameImage: image, clips })
          .catch((err) => {
            console.warn("moving print failed", err);
            return null;
          })
          .finally(() => recorder.release())
      : Promise.resolve(null);
    state.videoPromise = videoPromise;
    if (!clips) recorder?.release();

    drawQr($("qr-canvas"), guestUrl(id));
    canvas.classList.remove("develop");
    void canvas.offsetWidth;
    canvas.classList.add("develop");
    setUploadStatus(id, "encoding");
    show("result");

    const [photo, video] = await Promise.all([canvasToBlob(canvas, "image/jpeg", 0.9), videoPromise]);
    await queue.add({
      id,
      frameId: frame.kind === "png" ? frame.id : null,
      createdAt: Date.now(),
      photo,
      video: video?.blob ?? null,
      videoType: video?.type ?? null,
    });
  } finally {
    state.finishing = false;
  }
}

function setUploadStatus(id, status) {
  if (state.screen !== "result" && status !== "encoding") return;
  if (id !== state.sessionId) return;
  const offline = !navigator.onLine;
  $("upload-status").textContent = {
    encoding: "영상을 만들고 있어요",
    waiting: offline ? "인터넷에 연결되면 자동으로 올라가요" : "곧 올라가요",
    uploading: "사진과 영상을 올리고 있어요",
    retrying: "인터넷에 연결되면 자동으로 올라가요. QR은 그때부터 열려요",
    done: "올라갔어요. 지금 바로 받을 수 있어요",
  }[status] ?? "";
}

// ── idle timeout ────────────────────────────────────────────────────────

function watchIdle() {
  addEventListener("pointerdown", () => (state.lastTouch = Date.now()), { capture: true });
  setInterval(() => {
    const idle = Date.now() - state.lastTouch;
    const note = $("idle-note");
    if (state.screen === "result") {
      const left = IDLE_MS - idle;
      note.textContent = left <= IDLE_WARN_MS ? `${Math.max(1, Math.ceil(left / 1000))}초 뒤 처음 화면으로 돌아가요` : "";
    }
    if ((state.screen === "pick" || state.screen === "result" || state.screen === "camera-error") && idle > IDLE_MS) {
      goHome();
    }
    if (state.screen === "admin" && idle > 5 * IDLE_MS) goHome();
  }, 1000);
}

// ── boot ────────────────────────────────────────────────────────────────

async function boot() {
  // If on-device storage is unavailable, still open the booth with the
  // built-in frames; uploads retry once storage recovers.
  const device = await loadDeviceId().catch((err) => {
    console.error("device storage unavailable", err);
    return `tablet-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  });
  library = new FrameLibrary(api, config.eventName ?? "");
  queue = new UploadQueue(api, device);

  await library.loadCache().catch((err) => console.error("frame cache unavailable", err));
  library.addEventListener("change", () => renderFrameRows());
  await renderFrameRows();
  library.refresh().catch((err) => console.warn("frame refresh failed", err));
  setInterval(() => library.refresh().catch(() => {}), FRAME_REFRESH_MS);

  queue.addEventListener("change", () => {
    renderQueueNote();
    if (state.sessionId) setUploadStatus(state.sessionId, queue.status.get(state.sessionId));
  });
  queue.start().catch((err) => console.error("upload queue unavailable", err));

  $("pick-confirm").addEventListener("click", finishSession);
  $("pick-reshoot").addEventListener("click", () => state.frame && startSession(state.frame));
  $("result-home").addEventListener("click", goHome);
  $("camera-retry").addEventListener("click", () => state.frame && startSession(state.frame));
  for (const el of document.querySelectorAll("[data-go-home]")) el.addEventListener("click", goHome);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    queue.process();
    if (state.screen === "frames" && Date.now() - library.lastRefresh > FRAME_STALE_MS) library.refresh().catch(() => {});
  });

  setupAdmin({ api, library, show, goHome, toast });
  watchIdle();

  // Native only: keep the screen on while the booth is running.
  window.Capacitor?.Plugins?.KeepAwake?.keepAwake?.().catch?.(() => {});

  // Mock environment only: test hook, and clicking the QR opens the guest
  // page in a phone-sized window (a real phone can't reach localhost).
  if (config.dev) {
    window.__booth = { state, queue, library };
    $("qr-canvas").style.cursor = "pointer";
    $("qr-canvas").title = "테스트 모드: 클릭하면 손님 휴대폰 화면이 열려요";
    $("qr-canvas").addEventListener("click", () => {
      if (state.sessionId) window.open(guestUrl(state.sessionId), "guest", "width=400,height=820");
    });
  }
}

boot();
