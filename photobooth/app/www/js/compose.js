// Draws the finished photo strip: paper, four photos, then the frame on top.

import { LAYOUTS } from "./layouts.js";

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
export function renderComposite(canvas, frame, sources, frameImage, { placeholder = null, when = new Date(), scale = 1 } = {}) {
  const layout = LAYOUTS[frame.layout];
  canvas.width = Math.round(layout.width * scale);
  canvas.height = Math.round(layout.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  ctx.fillStyle = frame.paper ?? "#FFFFFF";
  ctx.fillRect(0, 0, layout.width, layout.height);

  layout.slots.forEach((slot, i) => {
    if (sources[i]) drawCover(ctx, sources[i], slot);
    else if (placeholder) {
      ctx.fillStyle = placeholder;
      ctx.fillRect(slot.x, slot.y, slot.w, slot.h);
    }
  });

  if (frame.kind === "builtin") frame.paintOverlay(ctx, when);
  else if (frameImage) ctx.drawImage(frameImage, 0, 0, layout.width, layout.height);
}

export function canvasToBlob(canvas, type = "image/jpeg", quality = 0.9) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), type, quality)
  );
}
