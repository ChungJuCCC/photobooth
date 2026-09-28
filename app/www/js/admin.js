// Hidden admin area: hold the top-right corner for 3 seconds, enter the PIN,
// then register or hide frames. The PIN is re-checked by the server on every
// action and only kept in memory while the admin screen is open.

import { ApiError } from "./api.js";
import { readSlots, renderComposite } from "./compose.js";
import { defaultFrameName, detectLayout, frameProblem, LAYOUTS, slotProblem } from "./layouts.js";

const HOLD_MS = 3000;
const $ = (id) => document.getElementById(id);

export function setupAdmin({ api, library, show, goHome, toast }) {
  let pin = "";
  let adminPin = null;
  let pending = null; // { layout, canvas } of the PNG being registered

  const version = $("app-version");
  if (version) version.textContent = `버전 ${window.BOOTH_CONFIG?.version || "개발"}`;

  // ── entry gesture ────────────────────────────────────────────────────
  // A finger never holds perfectly still for three seconds, and Android
  // cancels the pointer as soon as it reads the drift as a scroll. Capture
  // the pointer, allow real drift, and only give up if the finger lifts or
  // travels far enough to be somewhere else on purpose.
  const hotspot = $("admin-hotspot");
  const DRIFT_LIMIT = 60;
  let holdTimer = 0;
  let origin = null;

  const cancelHold = () => {
    clearTimeout(holdTimer);
    holdTimer = 0;
    origin = null;
    hotspot.classList.remove("holding");
  };

  hotspot.addEventListener("pointerdown", (e) => {
    cancelHold();
    origin = { x: e.clientX, y: e.clientY };
    try {
      hotspot.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a nicety; the hold still works without it.
    }
    hotspot.classList.add("holding");
    holdTimer = setTimeout(() => {
      cancelHold();
      openPin();
    }, HOLD_MS);
  });

  hotspot.addEventListener("pointermove", (e) => {
    if (!origin) return;
    if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > DRIFT_LIMIT) cancelHold();
  });

  // Second way in, for tablets where the OS keeps eating the long press:
  // five taps on the same corner inside two seconds.
  const TAP_TARGET = 5;
  const TAP_WINDOW_MS = 2000;
  let taps = [];

  hotspot.addEventListener("pointerup", () => {
    const now = Date.now();
    taps = taps.filter((t) => now - t < TAP_WINDOW_MS);
    taps.push(now);
    if (taps.length >= TAP_TARGET) {
      taps = [];
      cancelHold();
      openPin();
    }
  });

  for (const type of ["pointerup", "pointercancel"]) hotspot.addEventListener(type, cancelHold);
  hotspot.addEventListener("contextmenu", (e) => e.preventDefault());

  // ── PIN ──────────────────────────────────────────────────────────────
  const pinDialog = $("pin-dialog");

  function openPin() {
    pin = "";
    $("pin-message").textContent = "";
    renderDots();
    pinDialog.showModal();
  }

  function renderDots() {
    [...$("pin-dots").children].forEach((dot, i) => dot.classList.toggle("on", i < pin.length));
  }

  $("keypad").addEventListener("click", async (e) => {
    const key = e.target.closest("button");
    if (!key) return;
    if (key.dataset.key === "cancel") return pinDialog.close();
    if (key.dataset.key === "back") {
      pin = pin.slice(0, -1);
      return renderDots();
    }
    if (pin.length >= 4) return;
    pin += key.textContent.trim();
    renderDots();
    if (pin.length === 4) await submitPin();
  });

  async function submitPin() {
    const keypad = $("keypad");
    keypad.classList.add("busy");
    try {
      await api.manageFrames("verify", pin);
      adminPin = pin;
      pinDialog.close();
      await openAdmin();
    } catch (err) {
      $("pin-message").textContent = pinErrorText(err);
      pin = "";
      renderDots();
    } finally {
      keypad.classList.remove("busy");
    }
  }

  function pinErrorText(err) {
    if (!(err instanceof ApiError)) return "확인하지 못했어요. 다시 시도해주세요.";
    if (err.isNetwork) return "프레임 관리는 인터넷 연결이 필요해요.";
    if (err.code === "pin_wrong") return `PIN이 틀렸어요. ${err.data.remaining}번 더 틀리면 10분 동안 잠겨요.`;
    if (err.code === "pin_locked") {
      const until = new Date(err.data.lockedUntil);
      const hh = String(until.getHours()).padStart(2, "0");
      const mm = String(until.getMinutes()).padStart(2, "0");
      return `여러 번 틀려서 잠겼어요. ${hh}:${mm} 이후에 다시 시도해주세요.`;
    }
    if (err.code === "pin_not_set") return "관리자 PIN이 아직 설정되지 않았어요. 설치 안내서의 PIN 설정 단계를 확인해주세요.";
    if (err.code === "unauthorized") return "태블릿 설정의 부스 키가 서버와 달라요. 앱 설정을 확인해주세요.";
    return "확인하지 못했어요. 다시 시도해주세요.";
  }

  // ── admin screen ─────────────────────────────────────────────────────
  async function openAdmin() {
    show("admin");
    await loadList();
  }

  function adminMessage(text) {
    const el = $("admin-message");
    el.textContent = text;
    el.hidden = !text;
  }

  async function loadList() {
    adminMessage("");
    const list = $("admin-list");
    try {
      const { frames } = await api.manageFrames("list", adminPin);
      list.replaceChildren();
      if (!frames.length) {
        const empty = document.createElement("li");
        empty.className = "admin-empty";
        empty.textContent = "아직 등록한 프레임이 없어요. 지금은 기본 흑백 프레임만 나타나요.";
        list.append(empty);
        return;
      }
      for (const f of frames) list.append(await adminRow(f));
    } catch (err) {
      handleAdminError(err);
    }
  }

  async function adminRow(f) {
    const li = document.createElement("li");
    li.classList.toggle("hidden-frame", !f.isActive);

    const canvas = document.createElement("canvas");
    const cached = library.registered.find((r) => r.id === f.id);
    let image = cached ? await library.imageFor(cached).catch(() => null) : null;
    if (!image) {
      try {
        image = await createImageBitmap(await (await fetch(f.url)).blob());
      } catch {
        image = null;
      }
    }
    renderComposite(canvas, { layout: f.layout, kind: "png" }, [], image, { placeholder: "#E9E9E6", scale: 0.1 });

    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("strong");
    name.textContent = f.name;
    const detail = document.createElement("span");
    detail.textContent = f.isActive ? LAYOUTS[f.layout].label : `${LAYOUTS[f.layout].label}, 숨긴 프레임`;
    meta.append(name, detail);

    const act = (label, run) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button secondary";
      button.textContent = label;
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await run();
          await loadList();
        } catch (err) {
          handleAdminError(err);
          button.disabled = false;
        }
      });
      return button;
    };

    const people = act(f.hasPeople ? "인물 있음" : "인물 없음", async () => {
      await api.manageFrames("people", adminPin, { frameId: f.id, hasPeople: !f.hasPeople });
      toast(f.hasPeople ? "촬영 중에 인물을 안 보여줘요" : "촬영 중에 인물이 같이 보여요");
    });
    people.classList.toggle("on", f.hasPeople);

    const visible = act(f.isActive ? "숨기기" : "다시 보이기", async () => {
      await api.manageFrames(f.isActive ? "hide" : "show", adminPin, { frameId: f.id });
      toast(f.isActive ? "프레임을 숨겼어요" : "프레임을 다시 보이게 했어요");
    });

    const remove = act("삭제", async () => {
      if (!confirm(`"${f.name}" 프레임을 지울까요? 되돌릴 수 없어요.`)) throw new Cancelled();
      await api.manageFrames("delete-frame", adminPin, { frameId: f.id });
      await library.refresh().catch(() => {});
      toast("프레임을 지웠어요");
    });
    remove.classList.add("danger");

    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(people, visible, remove);

    li.append(canvas, meta, actions);
    return li;
  }

  // Thrown when a confirm dialog is declined, so the row just re-enables.
  class Cancelled extends Error {}

  function handleAdminError(err) {
    if (err instanceof Cancelled) return;
    if (err instanceof ApiError && ["pin_wrong", "pin_locked"].includes(err.code)) {
      adminPin = null;
      goHome();
      toast("관리자 PIN이 바뀌었어요. 다시 들어와주세요");
      return;
    }
    adminMessage(err instanceof ApiError && err.isNetwork
      ? "인터넷 연결을 확인해주세요."
      : "처리하지 못했어요. 잠시 후 다시 시도해주세요.");
  }

  // ── 찍은 사진 ────────────────────────────────────────────────────────

  const picked = new Set();

  for (const tab of document.querySelectorAll(".admin-tab")) {
    tab.addEventListener("click", () => {
      for (const other of document.querySelectorAll(".admin-tab")) other.classList.toggle("on", other === tab);
      for (const pane of document.querySelectorAll(".admin-pane")) pane.hidden = pane.dataset.tab !== tab.dataset.tab;
      if (tab.dataset.tab === "shots") loadShots();
    });
  }

  $("shots-refresh").addEventListener("click", () => loadShots());

  $("shots-delete").addEventListener("click", async () => {
    const ids = [...picked];
    if (!ids.length) return;
    if (!confirm(`사진 ${ids.length}개를 지울까요? 손님도 더는 받을 수 없어요.`)) return;
    const button = $("shots-delete");
    button.disabled = true;
    try {
      await api.manageFrames("delete-sessions", adminPin, { sessionIds: ids });
      toast(`사진 ${ids.length}개를 지웠어요`);
      picked.clear();
      await loadShots();
    } catch (err) {
      shotsMessage(err instanceof ApiError && err.isNetwork ? "인터넷 연결을 확인해주세요." : "지우지 못했어요.");
      button.disabled = false;
    }
  });

  function shotsMessage(text) {
    const el = $("shots-message");
    el.textContent = text;
    el.hidden = !text;
  }

  function updateShotsBar() {
    $("shots-delete").disabled = picked.size === 0;
    $("shots-delete").textContent = picked.size ? `선택 삭제 (${picked.size})` : "선택 삭제";
  }

  function shotWhen(iso) {
    const d = new Date(iso);
    return `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  async function loadShots() {
    shotsMessage("");
    const list = $("shot-list");
    try {
      const { sessions } = await api.manageFrames("sessions", adminPin);
      picked.clear();
      updateShotsBar();
      list.replaceChildren();
      if (!sessions.length) {
        const empty = document.createElement("li");
        empty.className = "admin-empty";
        empty.textContent = "아직 찍은 사진이 없어요.";
        list.append(empty);
        return;
      }
      for (const s of sessions) list.append(shotRow(s));
    } catch (err) {
      handleAdminError(err);
    }
  }

  function shotRow(session) {
    const li = document.createElement("li");
    li.className = "shot-item";

    const select = document.createElement("button");
    select.type = "button";
    select.className = "shot-pick";
    select.setAttribute("aria-pressed", "false");
    if (session.thumbUrl) {
      const img = document.createElement("img");
      img.src = session.thumbUrl;
      img.alt = "";
      select.append(img);
    } else {
      select.classList.add("empty");
    }
    select.addEventListener("click", () => {
      const on = !picked.has(session.id);
      if (on) picked.add(session.id);
      else picked.delete(session.id);
      li.classList.toggle("selected", on);
      select.setAttribute("aria-pressed", String(on));
      updateShotsBar();
    });

    const meta = document.createElement("div");
    meta.className = "meta";
    const when = document.createElement("strong");
    when.textContent = shotWhen(session.createdAt);
    const detail = document.createElement("span");
    detail.textContent = session.keep
      ? "보관 중 — 자동 삭제 안 함"
      : session.expiresAt
        ? `${shotWhen(session.expiresAt)}에 삭제`
        : "올라가는 중";
    meta.append(when, detail);

    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "button secondary";
    keep.classList.toggle("on", session.keep);
    keep.textContent = session.keep ? "보관 중" : "보관하기";
    keep.addEventListener("click", async () => {
      keep.disabled = true;
      try {
        await api.manageFrames("keep", adminPin, { sessionId: session.id, keep: !session.keep });
        toast(session.keep ? "보관을 해제했어요" : "이 사진은 계속 보관해요");
        await loadShots();
      } catch (err) {
        handleAdminError(err);
        keep.disabled = false;
      }
    });

    li.append(select, meta, keep);
    return li;
  }

  $("admin-close").addEventListener("click", () => {
    adminPin = null;
    library.refresh().catch(() => {});
    goHome();
  });

  // ── register ─────────────────────────────────────────────────────────
  const fileInput = $("frame-file");
  const registerDialog = $("register-dialog");

  $("admin-add").addEventListener("click", () => {
    fileInput.value = "";
    fileInput.click();
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (file) await inspect(file);
  });

  function showRegister({ title, message = "", preview = false }) {
    $("register-title").textContent = title;
    $("register-message").textContent = message;
    $("register-body").hidden = !preview;
    $("register-close-only").hidden = preview;
    if (!registerDialog.open) registerDialog.showModal();
  }

  async function inspect(file) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      return showRegister({ title: "등록할 수 없어요", message: "이미지를 열지 못했어요. PNG 파일인지 확인해주세요." });
    }

    const problem = frameProblem({ type: file.type, name: file.name, bytes: file.size, width: bitmap.width, height: bitmap.height });
    if (problem) {
      bitmap.close();
      return showRegister({ title: "등록할 수 없어요", message: problem });
    }

    // Scale to the exact layout size (e.g. a 2× export), then check the holes.
    const layout = detectLayout(bitmap.width, bitmap.height);
    const spec = LAYOUTS[layout];
    const canvas = document.createElement("canvas");
    canvas.width = spec.width;
    canvas.height = spec.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, spec.width, spec.height);
    bitmap.close();

    const slots = readSlots(canvas, layout);
    const openings = slotProblem(slots);
    if (openings) return showRegister({ title: "등록할 수 없어요", message: openings });

    pending = { layout, canvas, slots };
    renderComposite($("register-preview"), { layout, kind: "png", slots }, [], canvas, { placeholder: "#E9E9E6", scale: 0.4 });
    $("register-name").value = defaultFrameName(file.name);
    $("register-layout").textContent = `${spec.label} 프레임으로 등록돼요`;
    $("register-people").checked = false;
    $("register-submit").disabled = false;
    showRegister({ title: "이 프레임을 등록할까요?", preview: true });
  }

  $("register-submit").addEventListener("click", async () => {
    if (!pending) return;
    const name = $("register-name").value.replace(/\s+/g, " ").trim();
    if (!name) {
      $("register-message").textContent = "이름을 입력해주세요.";
      return;
    }
    const submit = $("register-submit");
    submit.disabled = true;
    $("register-message").textContent = "올리고 있어요";

    try {
      const png = await new Promise((resolve, reject) =>
        pending.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("png encode"))), "image/png")
      );
      const begin = await api.manageFrames("begin", adminPin, { name, layout: pending.layout });
      await api.putSigned(begin.signedUrl, png, "image/png");
      await api.manageFrames("finish", adminPin, {
        frameId: begin.frameId,
        name,
        layout: pending.layout,
        hasPeople: $("register-people").checked,
      });

      pending = null;
      registerDialog.close();
      toast("프레임을 등록했어요");
      await Promise.all([loadList(), library.refresh().catch(() => {})]);
    } catch (err) {
      submit.disabled = false;
      if (err instanceof ApiError && ["pin_wrong", "pin_locked"].includes(err.code)) {
        registerDialog.close();
        return handleAdminError(err);
      }
      $("register-message").textContent = err instanceof ApiError && err.isNetwork
        ? "인터넷 연결이 끊겼어요. 연결을 확인하고 다시 눌러주세요."
        : err instanceof ApiError && err.code === "bad_dimensions"
          ? "서버에서 크기 검사를 통과하지 못했어요. 파일을 다시 확인해주세요."
          : "등록하지 못했어요. 잠시 후 다시 시도해주세요.";
    }
  });

  for (const id of ["register-cancel", "register-dismiss"]) {
    $(id).addEventListener("click", () => {
      pending = null;
      registerDialog.close();
    });
  }
}
