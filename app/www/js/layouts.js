// Layout specs and frame rules. The top half is pure (tested in Node);
// the painters at the bottom only touch a canvas context when called.

export const PHOTO_RATIO = 499 / 396;

// The camera shoots whatever shape the chosen frame's cuts are, so nothing has
// to be cropped away between the viewfinder and the print.
export function slotRatio(layoutKey) {
  const slot = LAYOUTS[layoutKey]?.slots[0];
  return slot ? slot.w / slot.h : PHOTO_RATIO;
}

// Pixel size for a capture of that shape, with the long side fixed.
export function captureSize(ratio, longSide) {
  return ratio >= 1
    ? { width: longSide, height: Math.round(longSide / ratio) }
    : { width: Math.round(longSide * ratio), height: longSide };
}

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
    height: 1920,
    slots: [
      { x: 72, y: 82, w: 456, h: 676 },
      { x: 552, y: 82, w: 456, h: 676 },
      { x: 72, y: 781, w: 456, h: 676 },
      { x: 552, y: 781, w: 456, h: 676 },
    ],
  },
};

export const RATIO_TOLERANCE = 0.01;
export const MAX_FRAME_BYTES = 10 * 1024 * 1024;
const OPAQUE_ALPHA = 32;

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

// ── reading the cuts out of a frame ───────────────────────────────────
//
// A frame's photo slots are wherever it is transparent, so a designer can put
// the four cuts anywhere instead of matching fixed coordinates. The mask is a
// coarse alpha grid (see maskFromImage below); boxes come back in layout
// pixels, in reading order.

export const SLOT_COUNT = 4;
// Below this share of the sheet, a transparent patch is a gap in the artwork
// rather than a photo slot.
const MIN_SLOT_AREA = 0.015;

export function detectSlots(mask, maskWidth, maskHeight, { width, height } = {}) {
  const scaleX = (width ?? maskWidth) / maskWidth;
  const scaleY = (height ?? maskHeight) / maskHeight;
  const seen = new Uint8Array(mask.length);
  const minCells = MIN_SLOT_AREA * maskWidth * maskHeight;
  const boxes = [];

  for (let start = 0; start < mask.length; start++) {
    if (seen[start] || mask[start] > OPAQUE_ALPHA) continue;
    let x0 = maskWidth, y0 = maskHeight, x1 = -1, y1 = -1, cells = 0;
    const queue = [start];
    seen[start] = 1;
    while (queue.length) {
      const at = queue.pop();
      const x = at % maskWidth;
      const y = (at - x) / maskWidth;
      cells++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
      if (x > 0 && !seen[at - 1] && mask[at - 1] <= OPAQUE_ALPHA) (seen[at - 1] = 1, queue.push(at - 1));
      if (x < maskWidth - 1 && !seen[at + 1] && mask[at + 1] <= OPAQUE_ALPHA) (seen[at + 1] = 1, queue.push(at + 1));
      if (y > 0 && !seen[at - maskWidth] && mask[at - maskWidth] <= OPAQUE_ALPHA) (seen[at - maskWidth] = 1, queue.push(at - maskWidth));
      if (y < maskHeight - 1 && !seen[at + maskWidth] && mask[at + maskWidth] <= OPAQUE_ALPHA) (seen[at + maskWidth] = 1, queue.push(at + maskWidth));
    }
    if (cells < minCells) continue;
    boxes.push({
      // Grown by one mask cell: a photo that reaches under the artwork is
      // hidden by it, while one that falls short leaves a visible gap.
      x: Math.max(0, Math.round((x0 - 1) * scaleX)),
      y: Math.max(0, Math.round((y0 - 1) * scaleY)),
      w: Math.round((x1 - x0 + 3) * scaleX),
      h: Math.round((y1 - y0 + 3) * scaleY),
    });
  }

  if (boxes.length !== SLOT_COUNT) return null;
  return sortReadingOrder(boxes);
}

function sortReadingOrder(boxes) {
  const rowGap = Math.min(...boxes.map((b) => b.h)) / 2;
  return [...boxes].sort((a, b) => {
    const dy = a.y + a.h / 2 - (b.y + b.h / 2);
    return Math.abs(dy) > rowGap ? dy : a.x - b.x;
  });
}

// Why a frame's transparent areas can't be read as four photo slots.
export function slotProblem(slots) {
  if (slots) return null;
  return `사진이 들어갈 칸 ${SLOT_COUNT}개를 찾지 못했어요. 사진 자리 ${SLOT_COUNT}칸을 완전히 투명하게 비우고, 칸끼리 붙지 않게 사이를 띄워주세요.`;
}

// The shape the camera should shoot for this frame: its first cut.
export function frameSlots(frame) {
  return frame?.slots?.length === SLOT_COUNT ? frame.slots : LAYOUTS[frame.layout].slots;
}

export function frameRatio(frame) {
  const first = frameSlots(frame)[0];
  return first.w / first.h;
}

// Human-readable reason a PNG can't be registered, or null if it can.
export function frameProblem({ type, name, bytes, width, height }) {
  const isPng = type === "image/png" || /\.png$/i.test(name ?? "");
  // The picker now shows every image, so say why a JPEG can't be a frame.
  if (!isPng) return "PNG 파일만 등록할 수 있어요. 사진 칸이 뚫려 있어야 해서 투명 배경을 담을 수 있는 PNG만 됩니다.";
  if (bytes > MAX_FRAME_BYTES) return "파일이 너무 커요. 10MB 이하로 줄여주세요.";
  if (!detectLayout(width, height)) {
    return `세로 4컷은 591×1772, 바둑판은 1080×1920 비율이어야 해요. 지금 파일은 ${width}×${height}이에요.`;
  }
  return null;
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
              ctx.font = `700 44px "Wanted Sans Variable", sans-serif`;
              ctx.fillText(title.slice(0, 24), layout.width / 2, 1560);
            }
            ctx.fillStyle = tone.muted;
            ctx.font = `500 28px "Wanted Sans Variable", sans-serif`;
            ctx.fillText(dateLabel(when), layout.width / 2, title ? 1630 : 1560);
          }
          ctx.restore();
        },
      });
    }
  }
  return frames;
}
