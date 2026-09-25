// Hidden admin area: hold the top-right corner for 3 seconds, enter the PIN,
// then register or hide frames. The PIN is re-checked by the server on every
// action and only kept in memory while the admin screen is open.

import { ApiError } from "./api.js";
import { renderComposite } from "./compose.js";
import {
  blockedSlotsMessage,
  defaultFrameName,
  detectLayout,
  findBlockedSlots,
  frameProblem,
  LAYOUTS,
} from "./layouts.js";

const HOLD_MS = 3000;
const $ = (id) => document.getElementById(id);

export function setupAdmin({ api, library, show, goHome, toast }) {
  let pin = "";
  let adminPin = null;
  let pending = null; // { layout, canvas } of the PNG being registered

  // ── entry gesture ────────────────────────────────────────────────────
  const hotspot = $("admin-hotspot");
  let holdTimer = 0;
  const cancelHold = () => clearTimeout(holdTimer);
  hotspot.addEventListener("pointerdown", () => {
    cancelHold();
    holdTimer = setTimeout(openPin, HOLD_MS);
  });
  for (const type of ["pointerup", "pointerleave", "pointercancel"]) hotspot.addEventListener(type, cancelHold);
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

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "button secondary";
    toggle.textContent = f.isActive ? "숨기기" : "다시 보이기";
    toggle.addEventListener("click", async () => {
      toggle.disabled = true;
      try {
        await api.manageFrames(f.isActive ? "hide" : "show", adminPin, { frameId: f.id });
        toast(f.isActive ? "프레임을 숨겼어요" : "프레임을 다시 보이게 했어요");
        await loadList();
      } catch (err) {
        handleAdminError(err);
        toggle.disabled = false;
      }
    });

    li.append(canvas, meta, toggle);
    return li;
  }

  function handleAdminError(err) {
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

    const pixels = ctx.getImageData(0, 0, spec.width, spec.height).data;
    const blocked = findBlockedSlots(layout, (x, y) => pixels[(y * spec.width + x) * 4 + 3]);
    if (blocked.length) return showRegister({ title: "등록할 수 없어요", message: blockedSlotsMessage(blocked) });

    pending = { layout, canvas };
    renderComposite($("register-preview"), { layout, kind: "png" }, [], canvas, { placeholder: "#E9E9E6", scale: 0.4 });
    $("register-name").value = defaultFrameName(file.name);
    $("register-layout").textContent = `${spec.label} 프레임으로 등록돼요`;
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
      await api.manageFrames("finish", adminPin, { frameId: begin.frameId, name, layout: pending.layout });

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
