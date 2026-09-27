// Run with: node --test app/tests/
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  defaultFrameName,
  detectLayout,
  detectSlots,
  frameProblem,
  frameRatio,
  LAYOUTS,
  slotProblem,
} from "../www/js/layouts.js";

test("detectLayout accepts any scale with matching proportions", () => {
  assert.equal(detectLayout(591, 1772), "vertical");
  assert.equal(detectLayout(1182, 3544), "vertical");
  assert.equal(detectLayout(1080, 1920), "grid");
  assert.equal(detectLayout(2160, 3840), "grid");
  assert.equal(detectLayout(1080, 1930), "grid", "within 1%");
});

test("detectLayout rejects other proportions", () => {
  assert.equal(detectLayout(1000, 1500), null);
  assert.equal(detectLayout(1080, 1080), null);
  assert.equal(detectLayout(0, 100), null);
});

test("frameProblem explains what is wrong", () => {
  assert.match(frameProblem({ type: "image/jpeg", name: "a.jpg", bytes: 10, width: 591, height: 1772 }), /PNG/);
  assert.match(frameProblem({ type: "image/png", name: "a.png", bytes: 11 * 1024 * 1024, width: 591, height: 1772 }), /10MB/);
  assert.equal(
    frameProblem({ type: "image/png", name: "a.png", bytes: 10, width: 1000, height: 1500 }),
    "세로 4컷은 591×1772, 바둑판은 1080×1920 비율이어야 해요. 지금 파일은 1000×1500이에요.",
  );
  assert.equal(frameProblem({ type: "", name: "frame.PNG", bytes: 10, width: 1080, height: 1920 }), null);
});

// A mask of a sheet: opaque everywhere except the given cut-outs.
function maskOf(width, height, holes) {
  const mask = new Uint8Array(width * height).fill(255);
  for (const h of holes) {
    for (let y = h.y; y < h.y + h.h; y++) {
      for (let x = h.x; x < h.x + h.w; x++) mask[y * width + x] = 0;
    }
  }
  return mask;
}

test("detectSlots reads four cut-outs in reading order", () => {
  const holes = [
    { x: 2, y: 2, w: 20, h: 28 },
    { x: 28, y: 2, w: 20, h: 28 },
    { x: 2, y: 34, w: 20, h: 28 },
    { x: 28, y: 34, w: 20, h: 28 },
  ];
  const slots = detectSlots(maskOf(50, 70, holes), 50, 70);
  assert.equal(slots.length, 4);
  // Reading order, and each box covers its hole (grown by a cell either side).
  slots.forEach((slot, i) => {
    assert.ok(slot.x <= holes[i].x && slot.y <= holes[i].y, `slot ${i} starts at or before its hole`);
    assert.ok(slot.x + slot.w >= holes[i].x + holes[i].w, `slot ${i} reaches the hole's right edge`);
    assert.ok(slot.y + slot.h >= holes[i].y + holes[i].h, `slot ${i} reaches the hole's bottom edge`);
  });
});

test("detectSlots scales the boxes back to layout pixels", () => {
  const holes = [
    { x: 1, y: 1, w: 8, h: 10 },
    { x: 11, y: 1, w: 8, h: 10 },
    { x: 1, y: 13, w: 8, h: 10 },
    { x: 11, y: 13, w: 8, h: 10 },
  ];
  const slots = detectSlots(maskOf(20, 25, holes), 20, 25, { width: 200, height: 250 });
  assert.ok(slots.every((s) => s.w >= 80 && s.w <= 110), "boxes are ten times the mask cells");
});

test("detectSlots refuses anything that isn't four openings", () => {
  const three = [
    { x: 2, y: 2, w: 20, h: 28 },
    { x: 28, y: 2, w: 20, h: 28 },
    { x: 2, y: 34, w: 20, h: 28 },
  ];
  assert.equal(detectSlots(maskOf(50, 70, three), 50, 70), null, "three cut-outs");
  assert.equal(detectSlots(new Uint8Array(50 * 70).fill(255), 50, 70), null, "no cut-outs");
  // Cut-outs that touch each other read as one opening, not four.
  const joined = [{ x: 2, y: 2, w: 46, h: 60 }];
  assert.equal(detectSlots(maskOf(50, 70, joined), 50, 70), null, "one big opening");
});

test("detectSlots ignores specks of transparency", () => {
  const holes = [
    { x: 2, y: 2, w: 20, h: 28 },
    { x: 28, y: 2, w: 20, h: 28 },
    { x: 2, y: 34, w: 20, h: 28 },
    { x: 28, y: 34, w: 20, h: 28 },
    { x: 24, y: 66, w: 2, h: 2 }, // a gap in the artwork, not a photo slot
  ];
  assert.equal(detectSlots(maskOf(50, 70, holes), 50, 70).length, 4);
});

test("slotProblem explains a frame whose cuts can't be found", () => {
  assert.equal(slotProblem([{ x: 0, y: 0, w: 1, h: 1 }]), null);
  assert.match(slotProblem(null), /투명하게/);
});

test("frameRatio follows the frame's own cuts", () => {
  const custom = { layout: "grid", slots: [{ x: 0, y: 0, w: 300, h: 400 }, {}, {}, {}] };
  assert.equal(frameRatio(custom), 0.75);
  // A built-in frame falls back to the layout's own slots.
  assert.equal(frameRatio({ layout: "vertical" }), LAYOUTS.vertical.slots[0].w / LAYOUTS.vertical.slots[0].h);
});

test("defaultFrameName cleans up file names", () => {
  assert.equal(defaultFrameName("summer_frame-v2.png"), "summer frame v2");
  assert.equal(defaultFrameName(".png"), "새 프레임");
  assert.equal(defaultFrameName("x".repeat(40) + ".png").length, 30);
});
