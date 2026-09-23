// Layout specs and frame rules. The top half is pure (tested in Node);
// the painters at the bottom only touch a canvas context when called.

export const PHOTO_RATIO = 499 / 396;

export const LAYOUTS = {
  vertical: {
    key: "vertical",
    label: "세로 4컷",
    width: 591,
    height: 1772,
    slots: [
      { x: 46, y: 90, w: 499, h: 397 },
      { x: 46, y: 504, w: 499, h: 396 },
      { x: 46, y: 916, w: 499, h: 396 },
      { x: 46, y: 1329, w: 499, h: 396 },
    ],
  },
  grid: {
    key: "grid",
    label: "바둑판",
    width: 1080,
    height: 1200,
    slots: [
      { x: 40, y: 175, w: 487, h: 386 },
      { x: 553, y: 175, w: 487, h: 386 },
      { x: 40, y: 587, w: 487, h: 386 },
      { x: 553, y: 587, w: 487, h: 386 },
    ],
  },
};

export const RATIO_TOLERANCE = 0.01;
export const MAX_FRAME_BYTES = 10 * 1024 * 1024;
const OPAQUE_ALPHA = 32;
// A slot counts as blocked when more than this share of it is opaque.
// Corner stickers overlapping a photo cover roughly 1–10%; a slot left
// filled in (white, or a flattened export) covers close to 100%.
export const MAX_SLOT_COVERAGE = 0.3;
const SAMPLE_STEP = 4;

// Which layout a PNG of this size belongs to, or null. Any scale is fine as
// long as the proportions match (e.g. 1182×3544 is a 2× vertical frame).
export function detectLayout(width, height) {
  if (!(width > 0 && height > 0)) return null;
  const ratio = width / height;
  for (const layout of Object.values(LAYOUTS)) {
    const target = layout.width / layout.height;
    if (Math.abs(ratio - target) / target <= RATIO_TOLERANCE) return layout.key;
  }
  return null;
}

// Share (0..1) of each photo slot that the frame covers, measured on a grid.
// alphaAt(x, y) → 0..255 on the frame already resized to the layout size.
export function slotCoverage(layoutKey, alphaAt) {
  return LAYOUTS[layoutKey].slots.map((s) => {
    let covered = 0;
    let total = 0;
    for (let y = s.y; y < s.y + s.h; y += SAMPLE_STEP) {
      for (let x = s.x; x < s.x + s.w; x += SAMPLE_STEP) {
        total++;
        if (alphaAt(x, y) > OPAQUE_ALPHA) covered++;
      }
    }
    return covered / total;
  });
}

// 1-based numbers of the slots where too much of the photo would be hidden.
// Decorations that overlap a slot's edge are fine; a filled-in slot is not.
export function findBlockedSlots(layoutKey, alphaAt) {
  return slotCoverage(layoutKey, alphaAt)
    .map((share, index) => (share > MAX_SLOT_COVERAGE ? index + 1 : null))
    .filter((n) => n !== null);
}

// Human-readable reason a PNG can't be registered, or null if it can.
export function frameProblem({ type, name, bytes, width, height }) {
  const isPng = type === "image/png" || /\.png$/i.test(name ?? "");
  if (!isPng) return "PNG 파일만 등록할 수 있어요.";
  if (bytes > MAX_FRAME_BYTES) return "파일이 너무 커요. 10MB 이하로 줄여주세요.";
  if (!detectLayout(width, height)) {
    return `세로 4컷은 591×1772, 바둑판은 1080×1200 비율이어야 해요. 지금 파일은 ${width}×${height}이에요.`;
  }
  return null;
}

export function blockedSlotsMessage(slots) {
  const list = slots.join(", ");
  return `${list}번째 사진 칸이 대부분 가려져 있어요. 사진이 들어갈 자리는 비워서 투명하게 저장해주세요.`;
}

export function defaultFrameName(fileName) {
  const base = String(fileName ?? "").replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return (base || "새 프레임").slice(0, 30);
}

// ── built-in frames (drawn in code, no PNG needed) ─────────────────────

function dateLabel(date) {
  return `${date.getFullYear()}. ${date.getMonth() + 1}. ${date.getDate()}.`;
}

export function builtinFrames(eventName) {
  const tones = [
    { key: "white", name: "화이트", paper: "#FFFFFF", ink: "#000000", muted: "#6B7078" },
    { key: "black", name: "블랙", paper: "#000000", ink: "#FFFFFF", muted: "#9AA0A8" },
  ];
  const frames = [];
  for (const layout of Object.values(LAYOUTS)) {
    for (const tone of tones) {
      frames.push({
        id: `builtin-${layout.key}-${tone.key}`,
        name: tone.name,
        layout: layout.key,
        kind: "builtin",
        paper: tone.paper,
        paintOverlay(ctx, when = new Date()) {
          const title = eventName?.trim();
          ctx.save();
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          if (layout.key === "vertical") {
            if (title) {
              ctx.fillStyle = tone.ink;
              ctx.font = `600 30px "Wanted Sans Variable", sans-serif`;
              ctx.fillText(title.slice(0, 24), layout.width / 2, 50);
            }
            ctx.fillStyle = tone.muted;
            ctx.font = `500 20px "Wanted Sans Variable", sans-serif`;
            ctx.fillText(dateLabel(when), layout.width / 2, title ? 1750 : 50);
          } else {
            if (title) {
              ctx.fillStyle = tone.ink;
              ctx.font = `700 48px "Wanted Sans Variable", sans-serif`;
              ctx.fillText(title.slice(0, 24), layout.width / 2, 92);
            }
            ctx.fillStyle = tone.muted;
            ctx.font = `500 28px "Wanted Sans Variable", sans-serif`;
            ctx.fillText(dateLabel(when), layout.width / 2, title ? 1090 : 92);
          }
          ctx.restore();
        },
      });
    }
  }
  return frames;
}
