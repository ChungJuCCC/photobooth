// Guest download page. Opened from the QR code on the booth screen.
//
// Files are fetched exactly once as blobs; the preview and the save buttons
// both reuse those blobs, so a guest never downloads the same file twice
// (download volume is the tightest limit on the free Supabase plan).

const config = window.GUEST_CONFIG ?? {};
const params = new URLSearchParams(location.search);
const sessionId = params.get("id") ?? "";

const PENDING_POLL_MS = 10_000;
const COUNTDOWN_TICK_MS = 15_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const $ = (id) => document.getElementById(id);

const view = {
  photo: null, // { blob, url }
  video: null, // { blob, url, type }
  expiresAt: 0,
  pollTimer: 0,
  countdownTimer: 0,
  loading: false,
};

// ── state switching ─────────────────────────────────────────────────────

function show(state) {
  for (const section of document.querySelectorAll(".state")) {
    section.hidden = section.dataset.state !== state;
  }
  const ready = state === "ready";
  $("sheet").hidden = !ready;
  document.body.classList.toggle("has-sheet", ready);
  document.title = ready ? "내 사진" : "내 사진 받기";

  clearTimeout(view.pollTimer);
  if (state === "pending") view.pollTimer = setTimeout(load, PENDING_POLL_MS);
  if (state !== "ready") releaseFiles();
}

function releaseFiles() {
  clearInterval(view.countdownTimer);
  for (const file of [view.photo, view.video]) if (file) URL.revokeObjectURL(file.url);
  view.photo = null;
  view.video = null;
  $("photo").removeAttribute("src");
  $("video").removeAttribute("src");
}

// ── countdown ───────────────────────────────────────────────────────────

export function remainingText(ms) {
  if (ms <= 60_000) return "곧 삭제돼요. 지금 저장해주세요";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const amount = hours > 0 ? `${hours}시간 ${minutes}분` : `${minutes}분`;
  return `<strong>${amount}</strong> 뒤에 삭제돼요`;
}

function tickCountdown() {
  const left = view.expiresAt - Date.now();
  if (left <= 0) return show("expired");
  $("countdown").innerHTML = remainingText(left);
}

// ── loading ─────────────────────────────────────────────────────────────

async function fetchSession() {
  const url = `${config.functionsUrl}/get-session?id=${encodeURIComponent(sessionId)}`;
  const res = await fetch(url, { headers: { apikey: config.publishableKey ?? "" }, cache: "no-store" });
  if (!res.ok) throw new Error(`get-session ${res.status}`);
  return res.json();
}

async function fetchBlob(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`download ${res.status}`);
  return res.blob();
}

async function load() {
  if (view.loading) return;
  view.loading = true;
  try {
    let session = await fetchSession();
    if (session.state !== "ready") return show(session.state);

    let files;
    try {
      files = await downloadFiles(session);
    } catch {
      // Signed URLs last 10 minutes; if the page sat open, ask for new ones.
      session = await fetchSession();
      if (session.state !== "ready") return show(session.state);
      files = await downloadFiles(session);
    }

    releaseFiles();
    view.photo = files.photo;
    view.video = files.video;
    view.expiresAt = Date.parse(session.expiresAt);

    $("photo").src = view.photo.url;
    $("video-figure").hidden = !view.video;
    $("save-video").hidden = !view.video;
    if (view.video) $("video").src = view.video.url;
    $("long-press-hint").hidden = !IS_IOS;

    show("ready");
    tickCountdown();
    view.countdownTimer = setInterval(tickCountdown, COUNTDOWN_TICK_MS);
  } catch (err) {
    console.warn(err);
    show("error");
  } finally {
    view.loading = false;
  }
}

async function downloadFiles(session) {
  const [photoBlob, videoBlob] = await Promise.all([
    fetchBlob(session.photoUrl),
    session.videoUrl ? fetchBlob(session.videoUrl) : Promise.resolve(null),
  ]);
  return {
    photo: { blob: photoBlob, url: URL.createObjectURL(photoBlob) },
    video: videoBlob
      ? { blob: videoBlob, url: URL.createObjectURL(videoBlob), type: session.videoType ?? videoBlob.type }
      : null,
  };
}

// ── saving ──────────────────────────────────────────────────────────────

function fileName(kind, type) {
  const d = new Date(view.expiresAt - 24 * 3600_000);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const ext = kind === "photo" ? "jpg" : type?.includes("webm") ? "webm" : "mp4";
  return `photobooth-${stamp}-${kind === "photo" ? "photo" : "timelapse"}.${ext}`;
}

// iPhone Safari ignores download links, so it gets the share sheet
// ("이미지 저장"). Android and desktop get a normal download.
async function save(kind, button) {
  const file = kind === "photo" ? view.photo : view.video;
  if (!file) return;

  const type = kind === "photo" ? "image/jpeg" : (file.type || "video/mp4").split(";")[0];
  const name = fileName(kind, type);
  const label = button.textContent;
  button.disabled = true;

  try {
    const shareable = new File([file.blob], name, { type });
    if (IS_IOS && navigator.canShare?.({ files: [shareable] })) {
      try {
        await navigator.share({ files: [shareable] });
        return flash(button, label, "저장했어요");
      } catch (err) {
        if (err?.name === "AbortError") return; // guest closed the sheet
      }
    }
    const link = document.createElement("a");
    link.href = file.url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    flash(button, label, "저장했어요");
  } finally {
    button.disabled = false;
  }
}

function flash(button, original, message) {
  button.textContent = message;
  setTimeout(() => (button.textContent = original), 2200);
}

// ── start ───────────────────────────────────────────────────────────────

function start() {
  if (config.eventName) {
    $("event-name").textContent = config.eventName;
    $("event-name").hidden = false;
  }

  for (const button of document.querySelectorAll('[data-action="recheck"]')) {
    button.addEventListener("click", () => {
      show("loading");
      load();
    });
  }
  $("save-photo").addEventListener("click", (e) => save("photo", e.currentTarget));
  $("save-video").addEventListener("click", (e) => save("video", e.currentTarget));

  // Phones pause timers in the background; re-check when the guest returns.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const current = document.querySelector(".state:not([hidden])")?.dataset.state;
    if (current === "pending" || current === "error") load();
    if (current === "ready") tickCountdown();
  });

  if (!config.functionsUrl) {
    console.error("config.js is missing functionsUrl");
    return show("error");
  }
  if (!UUID_RE.test(sessionId)) return show("invalid");
  load();
}

start();
