// Run with: node --test supabase/tests/
import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { createMemoryDeps } from "../../dev/memory-deps.ts";
import {
  handleCleanup,
  handleCompleteUpload,
  handleCreateUpload,
  handleGetSession,
  handleListFrames,
  handleManageFrames,
} from "../functions/_shared/handlers.ts";
import {
  cleanFrameName,
  readPngSize,
  RETENTION_MS,
  sameSecret,
  type SessionRow,
  sessionState,
} from "../functions/_shared/logic.ts";

const BASE = "http://mock.local";
const BOOTH = { "x-booth-key": "dev-booth-key", "content-type": "application/json" };
const DEVICE = "tablet-0001";
const START = Date.parse("2026-09-17T09:00:00Z");

function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

const post = (fn: string, body: unknown, headers: Record<string, string> = BOOTH) =>
  new Request(`${BASE}/functions/v1/${fn}`, { method: "POST", headers, body: JSON.stringify(body) });

const get = (fn: string, query = "", headers: Record<string, string> = {}) =>
  new Request(`${BASE}/functions/v1/${fn}${query}`, { method: "GET", headers });

async function body(res: Response) {
  return await res.json();
}

// ── pure rules ──────────────────────────────────────────────────────────

describe("sessionState", () => {
  const id = "3f2b8c1e-4a5d-4e6f-9a7b-1c2d3e4f5a6b";
  const base: SessionRow = {
    id,
    device_id: DEVICE,
    frame_id: null,
    photo_path: `${id}/photo.jpg`,
    video_path: null,
    created_at: new Date(START).toISOString(),
    uploaded_at: null,
    expires_at: null,
    deleted_at: null,
  };
  const at = (ms: number) => new Date(START + ms);

  test("malformed id is invalid", () => {
    assert.equal(sessionState("not-a-uuid", null, at(0)), "invalid");
  });
  test("unknown or not-yet-uploaded session is pending", () => {
    assert.equal(sessionState(id, null, at(0)), "pending");
    assert.equal(sessionState(id, base, at(0)), "pending");
  });
  test("ready until the exact expiry instant", () => {
    const row = { ...base, uploaded_at: at(0).toISOString(), expires_at: at(RETENTION_MS).toISOString() };
    assert.equal(sessionState(id, row, at(RETENTION_MS - 1)), "ready");
    assert.equal(sessionState(id, row, at(RETENTION_MS)), "expired");
  });
  test("a purged session never goes back to pending", () => {
    assert.equal(sessionState(id, { ...base, deleted_at: at(0).toISOString() }, at(0)), "expired");
  });
});

describe("readPngSize", () => {
  test("reads IHDR dimensions", () => {
    assert.deepEqual(readPngSize(pngHeader(591, 1772)), { width: 591, height: 1772 });
  });
  test("rejects non-PNG and truncated data", () => {
    assert.equal(readPngSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(30).fill(0)])), null);
    assert.equal(readPngSize(pngHeader(10, 10).slice(0, 20)), null);
  });
});

test("sameSecret", () => {
  assert.equal(sameSecret("abc", "abc"), true);
  assert.equal(sameSecret("abc", "abd"), false);
  assert.equal(sameSecret("abc", "abcd"), false);
  assert.equal(sameSecret(null, "abc"), false);
});

test("cleanFrameName", () => {
  assert.equal(cleanFrameName("  여름  프레임 "), "여름 프레임");
  assert.equal(cleanFrameName(""), null);
  assert.equal(cleanFrameName("x".repeat(31)), null);
});

// ── handlers ────────────────────────────────────────────────────────────

describe("handlers", () => {
  let clock: number;
  let mem: ReturnType<typeof createMemoryDeps>;
  const tick = (ms: number) => (clock += ms);

  beforeEach(() => {
    clock = START;
    mem = createMemoryDeps({ baseUrl: BASE, now: () => new Date(clock), adminPin: "4827" });
  });

  const uploadTicket = (signedUrl: string) => signedUrl.split("/").pop()!;

  async function shoot(id = crypto.randomUUID(), withVideo = true) {
    const res = await handleCreateUpload(
      post("create-upload", { id, deviceId: DEVICE, videoType: withVideo ? "video/mp4" : null }),
      mem.deps,
    );
    assert.equal(res.status, 200);
    return { id, data: await body(res) };
  }

  async function uploadAndComplete(id: string, data: any) {
    assert.equal(mem.storageHttp.upload(uploadTicket(data.photo.signedUrl), new Uint8Array([1]), "image/jpeg"), 200);
    if (data.video) {
      assert.equal(mem.storageHttp.upload(uploadTicket(data.video.signedUrl), new Uint8Array([2]), "video/mp4"), 200);
    }
    return handleCompleteUpload(post("complete-upload", { id, deviceId: DEVICE }), mem.deps);
  }

  test("OPTIONS preflight is answered with CORS headers", async () => {
    const res = await handleCreateUpload(new Request(`${BASE}/x`, { method: "OPTIONS" }), mem.deps);
    assert.equal(res.status, 204);
    assert.match(res.headers.get("access-control-allow-headers") ?? "", /x-booth-key/);
  });

  test("booth endpoints reject a missing or wrong key", async () => {
    const id = crypto.randomUUID();
    const noKey = await handleCreateUpload(
      post("create-upload", { id, deviceId: DEVICE }, { "content-type": "application/json" }),
      mem.deps,
    );
    assert.equal(noKey.status, 401);
    const wrong = await handleListFrames(get("list-frames", "", { "x-booth-key": "nope" }), mem.deps);
    assert.equal(wrong.status, 401);
  });

  test("full guest journey: pending → ready → expired → purged", async () => {
    const { id, data } = await shoot();
    assert.equal(data.photo.path, `${id}/photo.jpg`);
    assert.equal(data.video.path, `${id}/timelapse.mp4`);

    // QR opened before upload finishes
    let state = await body(await handleGetSession(get("get-session", `?id=${id}`), mem.deps));
    assert.deepEqual(state, { state: "pending" });

    const done = await uploadAndComplete(id, data);
    assert.equal(done.status, 200);
    const { expiresAt } = await body(done);
    assert.equal(Date.parse(expiresAt), START + RETENTION_MS);

    tick(60_000);
    state = await body(await handleGetSession(get("get-session", `?id=${id}`), mem.deps));
    assert.equal(state.state, "ready");
    assert.ok(mem.storageHttp.readSigned(state.photoUrl.split("/").pop()), "photo URL downloads");
    assert.ok(mem.storageHttp.readSigned(state.videoUrl.split("/").pop()), "video URL downloads");
    assert.equal(state.videoType, "video/mp4");

    // Signed download URLs die after 10 minutes
    tick(10 * 60_000 + 1);
    assert.equal(mem.storageHttp.readSigned(state.photoUrl.split("/").pop()), null);

    // Exactly 24h after upload the page closes, even before cleanup runs
    clock = START + RETENTION_MS;
    state = await body(await handleGetSession(get("get-session", `?id=${id}`), mem.deps));
    assert.deepEqual(state, { state: "expired" });
    assert.equal(mem.objects.size, 2, "files still exist until cleanup");

    const cleanup = await handleCleanup(
      post("cleanup", {}, { "x-cleanup-token": "dev-cleanup-token" }),
      mem.deps,
    );
    assert.deepEqual(await body(cleanup), { status: "ok", purged: 1 });
    assert.equal(mem.objects.size, 0, "files deleted through storage");
    assert.ok(mem.sessions.get(id)?.deleted_at);

    // A second run finds nothing left to do
    const again = await handleCleanup(post("cleanup", {}, { "x-cleanup-token": "dev-cleanup-token" }), mem.deps);
    assert.equal((await body(again)).purged, 0);
  });

  test("photo-only session works without a video", async () => {
    const { id, data } = await shoot(undefined, false);
    assert.equal(data.video, null);
    assert.equal((await uploadAndComplete(id, data)).status, 200);
    const state = await body(await handleGetSession(get("get-session", `?id=${id}`), mem.deps));
    assert.equal(state.state, "ready");
    assert.equal(state.videoUrl, null);
  });

  test("complete-upload refuses until the files are really there", async () => {
    const { id, data } = await shoot();
    let res = await handleCompleteUpload(post("complete-upload", { id, deviceId: DEVICE }), mem.deps);
    assert.deepEqual([res.status, (await body(res)).error], [400, "missing_photo"]);

    mem.storageHttp.upload(uploadTicket(data.photo.signedUrl), new Uint8Array([1]), "image/jpeg");
    res = await handleCompleteUpload(post("complete-upload", { id, deviceId: DEVICE }), mem.deps);
    assert.deepEqual([res.status, (await body(res)).error], [400, "missing_video"]);
  });

  test("offline retry: same session can ask for fresh URLs, other devices cannot", async () => {
    const { id } = await shoot();
    const retry = await handleCreateUpload(post("create-upload", { id, deviceId: DEVICE, videoType: "video/webm" }), mem.deps);
    assert.equal(retry.status, 200);
    assert.equal((await body(retry)).video.path, `${id}/timelapse.webm`, "video type can change on retry");

    const other = await handleCreateUpload(post("create-upload", { id, deviceId: "tablet-9999" }), mem.deps);
    assert.equal(other.status, 409);
  });

  test("unknown or built-in frame ids are stored as null instead of failing", async () => {
    const id = crypto.randomUUID();
    const res = await handleCreateUpload(
      post("create-upload", { id, deviceId: DEVICE, frameId: crypto.randomUUID() }),
      mem.deps,
    );
    assert.equal(res.status, 200);
    assert.equal(mem.sessions.get(id)?.frame_id, null);

    const builtin = crypto.randomUUID();
    await handleCreateUpload(post("create-upload", { id: builtin, deviceId: DEVICE, frameId: "builtin-vertical" }), mem.deps);
    assert.equal(mem.sessions.get(builtin)?.frame_id, null);
  });

  test("create-upload after completion reports already_uploaded", async () => {
    const { id, data } = await shoot();
    await uploadAndComplete(id, data);
    const res = await handleCreateUpload(post("create-upload", { id, deviceId: DEVICE }), mem.deps);
    assert.deepEqual(await body(res), { status: "already_uploaded" });
  });

  test("rate limit: 30 new sessions per device per minute", async () => {
    for (let i = 0; i < 30; i++) await shoot();
    const res = await handleCreateUpload(post("create-upload", { id: crypto.randomUUID(), deviceId: DEVICE }), mem.deps);
    assert.equal(res.status, 429);
    tick(61_000);
    await shoot();
  });

  test("cleanup gives up on sessions never uploaded after 48h", async () => {
    const { id } = await shoot();
    clock = START + 47 * 3600_000;
    let res = await handleCleanup(post("cleanup", {}, { "x-cleanup-token": "dev-cleanup-token" }), mem.deps);
    assert.equal((await body(res)).purged, 0);
    clock = START + 48 * 3600_000 + 1;
    res = await handleCleanup(post("cleanup", {}, { "x-cleanup-token": "dev-cleanup-token" }), mem.deps);
    assert.equal((await body(res)).purged, 1);
    const state = await body(await handleGetSession(get("get-session", `?id=${id}`), mem.deps));
    assert.equal(state.state, "expired");
  });

  test("cleanup rejects a wrong token", async () => {
    const res = await handleCleanup(post("cleanup", {}, { "x-cleanup-token": "guess" }), mem.deps);
    assert.equal(res.status, 401);
  });

  test("admin PIN: 5 wrong tries lock for 10 minutes", async () => {
    const tryPin = async (pin: string) =>
      handleManageFrames(post("manage-frames", { action: "verify", pin }), mem.deps);

    for (let remaining = 4; remaining >= 1; remaining--) {
      const res = await tryPin("0000");
      assert.equal(res.status, 401);
      assert.equal((await body(res)).remaining, remaining);
    }
    assert.equal((await tryPin("0000")).status, 423);
    assert.equal((await tryPin("4827")).status, 423, "even the right PIN is refused while locked");

    tick(10 * 60_000);
    assert.equal((await tryPin("4827")).status, 200);
  });

  test("admin PIN not configured yet", async () => {
    mem = createMemoryDeps({ baseUrl: BASE, now: () => new Date(clock), adminPin: null });
    const res = await handleManageFrames(post("manage-frames", { action: "verify", pin: "1234" }), mem.deps);
    assert.equal(res.status, 409);
  });

  test("register a frame, reject wrong sizes, hide from tablets", async () => {
    const admin = (payload: Record<string, unknown>) =>
      handleManageFrames(post("manage-frames", { pin: "4827", ...payload }), mem.deps);

    // Good vertical frame
    let res = await admin({ action: "begin", name: "여름", layout: "vertical" });
    const begin = await body(res);
    mem.storageHttp.upload(uploadTicket(begin.signedUrl), pngHeader(591, 1772), "image/png");
    res = await admin({ action: "finish", frameId: begin.frameId, name: "여름", layout: "vertical" });
    assert.equal(res.status, 200);
    assert.equal((await body(res)).frame.layout, "vertical");

    // Same PNG claimed as a grid → rejected and file removed
    res = await admin({ action: "begin", name: "틀린 크기", layout: "grid" });
    const bad = await body(res);
    mem.storageHttp.upload(uploadTicket(bad.signedUrl), pngHeader(591, 1772), "image/png");
    res = await admin({ action: "finish", frameId: bad.frameId, name: "틀린 크기", layout: "grid" });
    assert.equal(res.status, 422);
    assert.deepEqual((await body(res)).expected, { width: 1080, height: 1200 });
    assert.equal(mem.objects.has(`frames/${bad.frameId}.png`), false);

    // Finishing without uploading
    res = await admin({ action: "begin", name: "빈 파일", layout: "grid" });
    const empty = await body(res);
    res = await admin({ action: "finish", frameId: empty.frameId, name: "빈 파일", layout: "grid" });
    assert.equal(res.status, 400);

    // Tablets see only active frames
    const list = async () =>
      (await body(await handleListFrames(get("list-frames", "", { "x-booth-key": "dev-booth-key" }), mem.deps))).frames;
    assert.equal((await list()).length, 1);
    assert.equal((await admin({ action: "hide", frameId: begin.frameId })).status, 200);
    assert.equal((await list()).length, 0);
    const all = await body(await admin({ action: "list" }));
    assert.equal(all.frames.length, 1);
    assert.equal(all.frames[0].isActive, false);
  });
});
