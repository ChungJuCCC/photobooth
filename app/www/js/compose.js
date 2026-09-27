// Draws the finished photo strip: paper, four photos, then the frame on top.

import { detectSlots, frameSlots, LAYOUTS } from "./layouts.js";

// One mask cell per this many layout pixels: fine enough to place a cut,
// cheap enough to run on every frame the booth downloads.
const MASK_STEP = 4;

function drawCover(ctx, source, slot) {
  const sw = source.width;
  const sh = source.height;
  if (!sw || !sh) return;
  const want = slot.w / slot.h;
  let cw = sw, ch = sh, cx = 0, cy = 0;
  if (sw / sh > want) {
    cw = sh * want;
    cx = (sw - cw) / 2;
  } else {
    ch = sw / want;
    cy = (sh - ch) / 2;
  }
  ctx.drawImage(source, cx, cy, cw, ch, slot.x, slot.y, slot.w, slot.h);
}

// sources: up to four drawables (ImageBitmap/canvas) in slot order.
// frameImage: decoded PNG for registered frames, ignored for built-ins.
// scale < 1 renders a smaller copy (thumbnails) without allocating full-size pixels.
// Paints one print into a context already scaled to layout coordinates.
// Shared by the still photo and by every frame of the moving version.
export function paintPrint(ctx, frame, sources, frameImage, when = new Date(), placeholder = null) {
  const layout = LAYOUTS[frame.layout];

  ctx.fillStyle = frame.paper ?? "#FFFFFF";
  ctx.fillRect(0, 0, layout.width, layout.height);

  frameSlots(frame).forEach((slot, i) => {
    if (sources[i]) drawCover(ctx, sources[i], slot);
    else if (placeholder) {
      ctx.fillStyle = placeholder;
      ctx.fillRect(slot.x, slot.y, slot.w, slot.h);
    }
  });

  if (frame.kind === "builtin") frame.paintOverlay(ctx, when);
  else if (frameImage) ctx.drawImage(frameImage, 0, 0, layout.width, layout.height);
}

export function renderComposite(canvas, frame, sources, frameImage, { placeholder = null, when = new Date(), scale = 1 } = {}) {
  const layout = LAYOUTS[frame.layout];
  canvas.width = Math.round(layout.width * scale);
  canvas.height = Math.round(layout.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  paintPrint(ctx, frame, sources, frameImage, when, placeholder);
}

export function canvasToBlob(canvas, type = "image/jpeg", quality = 0.9) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), type, quality)
  );
}

// Where a registered frame's photo slots are, read from its transparency.
// Returns null when the artwork doesn't have four clear openings.
export function readSlots(image, layoutKey) {
  const layout = LAYOUTS[layoutKey];
  const w = Math.round(layout.width / MASK_STEP);
  const h = Math.round(layout.height / MASK_STEP);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, w, h);
  const pixels = ctx.getImageData(0, 0, w, h).data;
  canvas.width = canvas.height = 0;

  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = pixels[i * 4 + 3];
  return detectSlots(mask, w, h, { width: layout.width, height: layout.height });
}
