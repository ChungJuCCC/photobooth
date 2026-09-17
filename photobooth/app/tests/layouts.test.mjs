// Run with: node --test app/tests/
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  blockedSlotsMessage,
  defaultFrameName,
  detectLayout,
  findBlockedSlots,
  frameProblem,
  LAYOUTS,
} from "../www/js/layouts.js";

test("detectLayout accepts any scale with matching proportions", () => {
  assert.equal(detectLayout(591, 1772), "vertical");
  assert.equal(detectLayout(1182, 3544), "vertical");
  assert.equal(detectLayout(1080, 1200), "grid");
  assert.equal(detectLayout(2160, 2400), "grid");
  assert.equal(detectLayout(1000, 1110), "grid", "within 1%");
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
    "세로 4컷은 591×1772, 바둑판은 1080×1200 비율이어야 해요. 지금 파일은 1000×1500이에요.",
  );
  assert.equal(frameProblem({ type: "", name: "frame.PNG", bytes: 10, width: 1080, height: 1200 }), null);
});

function alphaMap(layoutKey, opaqueSlots) {
  const slots = LAYOUTS[layoutKey].slots;
  return (x, y) => {
    const index = slots.findIndex((s) => x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h);
    if (index === -1) return 255; // frame border is opaque
    return opaqueSlots.includes(index + 1) ? 255 : 0;
  };
}

test("findBlockedSlots flags slots that are not transparent", () => {
  assert.deepEqual(findBlockedSlots("vertical", alphaMap("vertical", [])), []);
  assert.deepEqual(findBlockedSlots("grid", alphaMap("grid", [3])), [3]);
  assert.deepEqual(findBlockedSlots("vertical", alphaMap("vertical", [1, 4])), [1, 4]);
  assert.equal(blockedSlotsMessage([1, 4]), "1, 4번째 사진 칸이 투명하지 않아요. 사진이 들어갈 자리는 비워서 투명하게 저장해주세요.");
});

test("a slot with only its center punched out still counts as blocked", () => {
  const s = LAYOUTS.grid.slots[1];
  const alpha = (x, y) => {
    const inSlot2 = x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h;
    const nearCenter = Math.abs(x - (s.x + s.w / 2)) < 30 && Math.abs(y - (s.y + s.h / 2)) < 30;
    return inSlot2 && nearCenter ? 0 : inSlot2 ? 255 : alphaMap("grid", [])(x, y);
  };
  assert.deepEqual(findBlockedSlots("grid", alpha), [2]);
});

test("defaultFrameName cleans up file names", () => {
  assert.equal(defaultFrameName("summer_frame-v2.png"), "summer frame v2");
  assert.equal(defaultFrameName(".png"), "새 프레임");
  assert.equal(defaultFrameName("x".repeat(40) + ".png").length, 30);
});
