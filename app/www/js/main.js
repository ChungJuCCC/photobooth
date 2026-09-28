// Booth flow: frames → shoot 6 → pick 4 → result + QR.

import { createApi } from "./api.js";
import { Camera, CameraError, drawPerson } from "./camera.js";
import { canvasToBlob, renderComposite } from "./compose.js";
import { deviceId as loadDeviceId } from "./db.js";
import { FrameLibrary } from "./frames.js";
import { UploadQueue } from "./queue.js";
import { ClipRecorder, renderMotionPrint } from "./motion.js";
import { captureSize, frameRatio, slotRatio } from "./layouts.js";
import { setupAdmin } from "./admin.js";
import qrcode from "../vendor/qrcode.mjs";

const config = window.BOOTH_CONFIG ?? {};

const SHOTS = 6;
const SHOTS_WITH_PEOPLE = 8; // more takes, so every pose gets a turn
const OVERLAY_LONG_SIDE = 800; // the viewfinder copy of the person
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

// Thrown to unwind the shooting loop when someone leaves mid-shoot.
class ShootCancelled extends Error {}

const state = {
  screen: "frames",
  cancelled: false,
  // "frame-first": pick a frame, then shoot.
  // "people-first": shoot with the cast, then pick a frame for the prints.
  flow: "frame-first",
  pickingFrame: false,
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
  state.cancelled = true;
  state.flow = "frame-first";
  resetFrameScreen();
  camera.stop();
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
    // Shots taken with the cast are portrait, so only frames with portrait
    // cuts can hold them.
    row.parentElement.hidden = state.pickingFrame && layout !== PEOPLE_LAYOUT;
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
      card.addEventListener("click", () => (state.pickingFrame ? applyFrame(frame) : startSession(frame)));
      row.append(card);

      const image = await library.imageFor(frame).catch(() => null);
      renderComposite(canvas, frame, [], image, { placeholder: "#E9E9E6", scale: 0.35 });
    }
  }
}

// The cast shoots in this layout's cut shape, whatever frame is chosen after.
const PEOPLE_LAYOUT = "grid";

// Stand-in used to preview a shoot whose frame has not been chosen yet.
function plainPeopleFrame() {
  return library.builtins.find((f) => f.layout === PEOPLE_LAYOUT) ?? library.builtins[0];
}

// "기훈간사님" + 과 / "친구" + 와 — the particle follows the last letter.
function withParticle(name) {
  const last = name.trim().slice(-1);
  const code = last.charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return `${name}와`;
  return (code - 0xac00) % 28 === 0 ? `${name}와` : `${name}과`;
}

function renderCastButton() {
  const button = $("with-people");
  const cast = library.people;
  button.hidden = state.pickingFrame || cast.length === 0;
  if (button.hidden) return;

  $("with-people-text").textContent = `${withParticle(library.peopleLabel)} 함께 찍기`;
  const strip = $("with-people-cast");
  if (strip.childElementCount !== Math.min(cast.length, 3)) {
    strip.replaceChildren();
    for (const person of cast.slice(0, 3)) {
      const img = document.createElement("img");
      img.src = URL.createObjectURL(person.blob);
      img.alt = "";
      img.addEventListener("load", () => URL.revokeObjectURL(img.src), { once: true });
      strip.append(img);
    }
  }
}

// After a shoot with the cast, the same screen becomes the frame chooser.
function askForFrame() {
  state.pickingFrame = true;
  document.body.classList.add("picking-frame");
  $("frames-title").textContent = "어떤 프레임에 담을까요?";
  $("frames-lede").textContent = "고르면 바로 완성돼요";
  renderCastButton();
  renderFrameRows();
  show("frames");
}

function resetFrameScreen() {
  state.pickingFrame = false;
  document.body.classList.remove("picking-frame");
  $("frames-title").textContent = "프레임을 골라주세요";
  $("frames-lede").textContent = "마음에 드는 디자인을 누르면 바로 촬영을 시작해요";
  renderCastButton();
}

function renderQueueNote() {
  const note = $("queue-note");
  note.hidden = queue.pending === 0;
  note.textContent = `아직 올라가지 않은 사진 ${queue.pending}건이 있어요. 인터넷에 연결되면 자동으로 올라가요.`;
}

// ── 2. shooting ─────────────────────────────────────────────────────────

// frame === null means the cast leads and the frame is chosen afterwards.
async function startSession(frame) {
  if (state.shooting) return;
  state.shooting = true;
  state.cancelled = false;
  state.pickingFrame = false;
  releaseShots();
  state.flow = frame ? "frame-first" : "people-first";
  state.frame = frame;
  state.sessionId = crypto.randomUUID();

  // The cast only joins the shoot the guests asked for.
  const cast = [];
  if (state.flow === "people-first") {
    for (const person of library.people) {
      const image = await library.personImage(person).catch(() => null);
      if (image) cast.push(image);
    }
  }
  const shots = cast.length ? SHOTS_WITH_PEOPLE : SHOTS;
  state.shotCount = shots;

  const strip = $("shot-strip");
  strip.replaceChildren(...Array.from({ length: shots }, () => document.createElement("li")));
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
  // Viewfinder, takes and clips all take the shape of the cuts they will land
  // in, which for a registered PNG is read from its own transparency.
  if (state.frame) await library.imageFor(state.frame).catch(() => null);
  const ratio = state.frame ? frameRatio(state.frame) : slotRatio(PEOPLE_LAYOUT);
  document.documentElement.style.setProperty("--shot-ratio", String(ratio));
  let clips = null;
  try {
    clips = new ClipRecorder($("camera-video"), ratio);
    clips.start();
    await wait(1500);

    for (let i = 0; i < shots; i++) {
      if (state.cancelled) throw new ShootCancelled();
      const person = cast.length ? cast[i % cast.length] : null;
      clips.person = person;
      $("shot-counter").textContent = `${i + 1} / ${shots}`;
      $("shoot-title").textContent = shootTitle(i, shots, cast.length > 0);
      strip.children[i].classList.add("current");
      showPerson(person, ratio);

      for (let n = i === 0 ? COUNTDOWN_TICKS + 1 : COUNTDOWN_TICKS; n >= 1; n--) {
        const el = $("countdown");
        el.textContent = n;
        el.classList.remove("tick");
        void el.offsetWidth;
        el.classList.add("tick");
        await wait(TICK_MS);
        if (state.cancelled) throw new ShootCancelled();
      }

      const flash = $("flash");
      flash.classList.remove("fire");
      void flash.offsetWidth;
      flash.classList.add("fire");

      const shot = await camera.takePhoto(ratio, person);
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
    hidePerson();
    camera.stop();

    state.picked = [];
    renderPick();
    show("pick");
  } catch (err) {
    clips?.release();
    state.clips = null;
    hidePerson();
    camera.stop();
    // Walking away is not a fault; goHome has already shown the way back.
    if (!(err instanceof ShootCancelled)) showCameraError(err);
  } finally {
    state.shooting = false;
  }
}

// The person posing with the guests, drawn over the live camera exactly where
// the shutter will put them.
function showPerson(image, ratio) {
  const canvas = $("camera-overlay");
  if (!image) return hidePerson();
  const { width, height } = captureSize(ratio, OVERLAY_LONG_SIDE);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  drawPerson(ctx, image, width, height);
  canvas.hidden = false;
}

function hidePerson() {
  const canvas = $("camera-overlay");
  canvas.hidden = true;
  canvas.width = canvas.height = 0;
}

// What to say between takes. With someone posing along, the prompts point at
// them instead of at the camera.
function shootTitle(index, total, withPeople) {
  if (index === 0) return withPeople ? "옆에 서서 자세를 잡아주세요" : "자세를 잡아주세요";
  if (index === total - 1) return "마지막 한 장";
  const alone = ["좋아요, 다음 포즈", "표정을 바꿔볼까요", "한 번 더", "거의 다 왔어요"];
  const together = ["다음 사람이 나왔어요", "포즈를 따라해볼까요", "한 번 더", "좋아요, 계속", "이번엔 다르게", "거의 다 왔어요"];
  const list = withPeople ? together : alone;
  return list[(index - 1) % list.length];
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

  const frame = state.frame ?? plainPeopleFrame();
  const image = await library.imageFor(frame).catch(() => null);
  renderComposite($("pick-preview"), frame, state.picked.map((i) => state.shots[i].bitmap), image, {
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

// The guests have chosen their four. With the cast, the frame is still to
// come; otherwise the print can be made now.
function confirmPick() {
  if (state.flow === "people-first" && !state.frame) return askForFrame();
  return finishSession();
}

function applyFrame(frame) {
  state.frame = frame;
  resetFrameScreen();
  finishSession();
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
  library.addEventListener("change", () => {
    renderCastButton();
    renderFrameRows();
  });
  await renderFrameRows();
  renderCastButton();
  library.refresh().catch((err) => console.warn("frame refresh failed", err));
  setInterval(() => library.refresh().catch(() => {}), FRAME_REFRESH_MS);

  queue.addEventListener("change", () => {
    renderQueueNote();
    if (state.sessionId) setUploadStatus(state.sessionId, queue.status.get(state.sessionId));
  });
  queue.start().catch((err) => console.error("upload queue unavailable", err));

  $("pick-confirm").addEventListener("click", confirmPick);
  $("pick-reshoot").addEventListener("click", () => startSession(state.flow === "people-first" ? null : state.frame));
  $("result-home").addEventListener("click", goHome);
  $("camera-retry").addEventListener("click", () => startSession(state.flow === "people-first" ? null : state.frame));
  $("with-people").addEventListener("click", () => startSession(null));
  for (const el of document.querySelectorAll("[data-go-home]")) el.addEventListener("click", goHome);

  // Android's back button: come back to the booth's first screen rather than
  // leaving the app. Two history entries are kept so the WebView always has
  // somewhere to go back to, and the handler puts one back each time.
  history.replaceState({ booth: "home" }, "");
  history.pushState({ booth: "step" }, "");
  addEventListener("popstate", () => {
    history.pushState({ booth: "step" }, "");
    const dialog = document.querySelector("dialog[open]");
    if (dialog) return dialog.close();
    if (state.screen !== "frames") goHome();
  });

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
