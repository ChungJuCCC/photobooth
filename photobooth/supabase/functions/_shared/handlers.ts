// Request handlers for every photobooth function. Each takes a standard
// Request plus injected dependencies, so production (Supabase) and tests /
// the local mock server (in-memory) run exactly the same code.

import {
  cleanFrameName,
  expiresAtFrom,
  type FrameRow,
  isDeviceId,
  isLayout,
  isPin,
  isUuid,
  LAYOUT_SIZES,
  matchesLayout,
  readPngSize,
  sameSecret,
  SESSIONS_PER_DEVICE_PER_MINUTE,
  sessionPaths,
  type SessionRow,
  sessionState,
  SIGNED_DOWNLOAD_SECONDS,
  UNUPLOADED_GIVE_UP_MS,
  videoExtension,
} from "./logic.ts";

export type PinCheck =
  | { result: "ok" }
  | { result: "wrong"; remaining: number }
  | { result: "locked"; lockedUntil: string }
  | { result: "unset" };

export interface Db {
  getSession(id: string): Promise<SessionRow | null>;
  insertSession(row: SessionRow): Promise<void>;
  updateSession(id: string, patch: Partial<SessionRow>): Promise<void>;
  countSessionsSince(deviceId: string, sinceIso: string): Promise<number>;
  listSessionsToPurge(nowIso: string, giveUpBeforeIso: string, limit: number): Promise<SessionRow[]>;
  listFrames(includeHidden: boolean): Promise<FrameRow[]>;
  getFrame(id: string): Promise<FrameRow | null>;
  insertFrame(row: FrameRow): Promise<void>;
  updateFrame(id: string, patch: Partial<FrameRow>): Promise<void>;
  checkAdminPin(pin: string): Promise<PinCheck>;
}

export interface Storage {
  createSignedUploadUrl(bucket: string, path: string): Promise<string>;
  createSignedUrl(bucket: string, path: string, seconds: number): Promise<string>;
  exists(bucket: string, path: string): Promise<boolean>;
  download(bucket: string, path: string): Promise<Uint8Array | null>;
  remove(bucket: string, paths: string[]): Promise<void>;
  publicUrl(bucket: string, path: string): string;
}

export type Deps = {
  db: Db;
  storage: Storage;
  env: { BOOTH_KEY?: string; CLEANUP_TOKEN?: string };
  now: () => Date;
  newId: () => string;
};

export const SESSIONS_BUCKET = "sessions";
export const FRAMES_BUCKET = "frames";

// ── HTTP helpers ────────────────────────────────────────────────────────

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-booth-key, x-cleanup-token",
  "Access-Control-Max-Age": "86400",
};

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function fail(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return json(status, { error: code, ...extra });
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await req.text();
    if (text.length > 16_000) return null;
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Runs one handler with the shared preflight, method and error envelope.
export async function serve(
  req: Request,
  methods: string[],
  handler: () => Promise<Response>,
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (!methods.includes(req.method)) return fail(405, "method_not_allowed");
  try {
    return await handler();
  } catch (err) {
    console.error(err);
    return fail(500, "internal_error");
  }
}

function boothAuthorized(req: Request, deps: Deps): Response | null {
  if (!deps.env.BOOTH_KEY) return fail(500, "server_misconfigured");
  if (!sameSecret(req.headers.get("x-booth-key"), deps.env.BOOTH_KEY)) return fail(401, "unauthorized");
  return null;
}

// ── create-upload ───────────────────────────────────────────────────────
// Tablet asks for signed upload URLs for one session. Safe to call again for
// the same session (e.g. after the 2 hour URL lifetime ran out offline).

export function handleCreateUpload(req: Request, deps: Deps): Promise<Response> {
  return serve(req, ["POST"], async () => {
    const denied = boothAuthorized(req, deps);
    if (denied) return denied;

    const body = await readBody(req);
    if (!body) return fail(400, "invalid_body");
    const { id, deviceId, frameId, videoType } = body;
    if (!isUuid(id)) return fail(400, "invalid_id");
    if (!isDeviceId(deviceId)) return fail(400, "invalid_device");
    if (videoType != null && !videoExtension(videoType)) return fail(400, "invalid_video_type");

    const existing = await deps.db.getSession(id);
    if (existing && existing.device_id !== deviceId) return fail(409, "session_conflict");
    if (existing?.uploaded_at) return json(200, { status: "already_uploaded" });
    if (existing?.deleted_at) return fail(410, "session_expired");

    const now = deps.now();
    const paths = sessionPaths(id, videoType);

    if (existing) {
      await deps.db.updateSession(id, { photo_path: paths.photo, video_path: paths.video });
    } else {
      const since = new Date(now.getTime() - 60_000).toISOString();
      if ((await deps.db.countSessionsSince(deviceId, since)) >= SESSIONS_PER_DEVICE_PER_MINUTE) {
        return fail(429, "rate_limited");
      }
      // Built-in frames have no row, and a registered frame may have been
      // removed since the photo was taken offline. Link only if it exists.
      const knownFrame = isUuid(frameId) && (await deps.db.getFrame(frameId)) ? frameId : null;
      await deps.db.insertSession({
        id,
        device_id: deviceId,
        frame_id: knownFrame,
        photo_path: paths.photo,
        video_path: paths.video,
        created_at: now.toISOString(),
        uploaded_at: null,
        expires_at: null,
        deleted_at: null,
      });
    }

    const photoUrl = await deps.storage.createSignedUploadUrl(SESSIONS_BUCKET, paths.photo);
    const videoUrl = paths.video ? await deps.storage.createSignedUploadUrl(SESSIONS_BUCKET, paths.video) : null;

    return json(200, {
      status: "ok",
      photo: { path: paths.photo, signedUrl: photoUrl },
      video: paths.video ? { path: paths.video, signedUrl: videoUrl } : null,
    });
  });
}

// ── complete-upload ─────────────────────────────────────────────────────
// Tablet reports both files are uploaded. The 24h clock starts here.

export function handleCompleteUpload(req: Request, deps: Deps): Promise<Response> {
  return serve(req, ["POST"], async () => {
    const denied = boothAuthorized(req, deps);
    if (denied) return denied;

    const body = await readBody(req);
    if (!body) return fail(400, "invalid_body");
    const { id, deviceId } = body;
    if (!isUuid(id) || !isDeviceId(deviceId)) return fail(400, "invalid_body");

    const row = await deps.db.getSession(id);
    if (!row || row.device_id !== deviceId) return fail(404, "session_not_found");
    if (row.deleted_at) return fail(410, "session_expired");
    if (row.uploaded_at) return json(200, { status: "ok", expiresAt: row.expires_at });

    if (!(await deps.storage.exists(SESSIONS_BUCKET, row.photo_path))) return fail(400, "missing_photo");
    if (row.video_path && !(await deps.storage.exists(SESSIONS_BUCKET, row.video_path))) {
      return fail(400, "missing_video");
    }

    const uploadedAt = deps.now();
    const expiresAt = expiresAtFrom(uploadedAt).toISOString();
    await deps.db.updateSession(id, { uploaded_at: uploadedAt.toISOString(), expires_at: expiresAt });
    return json(200, { status: "ok", expiresAt });
  });
}

// ── get-session ─────────────────────────────────────────────────────────
// Public. The guest page polls this with the id from the QR code.

export function handleGetSession(req: Request, deps: Deps): Promise<Response> {
  return serve(req, ["GET"], async () => {
    const id = new URL(req.url).searchParams.get("id") ?? "";
    const row = isUuid(id) ? await deps.db.getSession(id) : null;
    const state = sessionState(id, row, deps.now());

    if (state !== "ready" || !row) return json(200, { state });

    const photoUrl = await deps.storage.createSignedUrl(SESSIONS_BUCKET, row.photo_path, SIGNED_DOWNLOAD_SECONDS);
    const videoUrl = row.video_path
      ? await deps.storage.createSignedUrl(SESSIONS_BUCKET, row.video_path, SIGNED_DOWNLOAD_SECONDS)
      : null;

    return json(200, {
      state,
      expiresAt: row.expires_at,
      photoUrl,
      videoUrl,
      videoType: row.video_path?.endsWith(".webm") ? "video/webm" : row.video_path ? "video/mp4" : null,
    });
  });
}

// ── list-frames ─────────────────────────────────────────────────────────
// Tablets refresh their frame list here. Also keeps a free project awake.

function frameDto(row: FrameRow, deps: Deps) {
  return {
    id: row.id,
    name: row.name,
    layout: row.layout,
    url: deps.storage.publicUrl(FRAMES_BUCKET, row.path),
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

export function handleListFrames(req: Request, deps: Deps): Promise<Response> {
  return serve(req, ["GET"], async () => {
    const denied = boothAuthorized(req, deps);
    if (denied) return denied;
    const rows = await deps.db.listFrames(false);
    return json(200, { frames: rows.map((r) => frameDto(r, deps)) });
  });
}

// ── manage-frames ───────────────────────────────────────────────────────
// Admin actions from the tablet. Every call carries the PIN and is checked
// server-side, so a lost admin screen can't be replayed without it.

export function handleManageFrames(req: Request, deps: Deps): Promise<Response> {
  return serve(req, ["POST"], async () => {
    const denied = boothAuthorized(req, deps);
    if (denied) return denied;

    const body = await readBody(req);
    if (!body) return fail(400, "invalid_body");
    const { action, pin } = body;
    if (!isPin(pin)) return fail(400, "invalid_pin_format");

    const check = await deps.db.checkAdminPin(pin);
    if (check.result === "unset") return fail(409, "pin_not_set");
    if (check.result === "locked") return fail(423, "pin_locked", { lockedUntil: check.lockedUntil });
    if (check.result === "wrong") return fail(401, "pin_wrong", { remaining: check.remaining });

    switch (action) {
      case "verify":
        return json(200, { status: "ok" });

      case "list": {
        const rows = await deps.db.listFrames(true);
        return json(200, { frames: rows.map((r) => frameDto(r, deps)) });
      }

      case "begin": {
        if (!cleanFrameName(body.name)) return fail(400, "invalid_name");
        if (!isLayout(body.layout)) return fail(400, "invalid_layout");
        const frameId = deps.newId();
        const path = `${frameId}.png`;
        const signedUrl = await deps.storage.createSignedUploadUrl(FRAMES_BUCKET, path);
        return json(200, { status: "ok", frameId, path, signedUrl });
      }

      case "finish": {
        const name = cleanFrameName(body.name);
        const { frameId, layout } = body;
        if (!name) return fail(400, "invalid_name");
        if (!isUuid(frameId)) return fail(400, "invalid_frame_id");
        if (!isLayout(layout)) return fail(400, "invalid_layout");
        if (await deps.db.getFrame(frameId)) return fail(409, "frame_exists");

        const path = `${frameId}.png`;
        const bytes = await deps.storage.download(FRAMES_BUCKET, path);
        if (!bytes) return fail(400, "upload_missing");

        const size = readPngSize(bytes);
        if (!size || !matchesLayout(size, layout)) {
          await deps.storage.remove(FRAMES_BUCKET, [path]);
          return fail(422, "bad_dimensions", { expected: LAYOUT_SIZES[layout], actual: size });
        }

        const row: FrameRow = {
          id: frameId,
          name,
          layout,
          path,
          is_active: true,
          created_at: deps.now().toISOString(),
        };
        await deps.db.insertFrame(row);
        return json(200, { status: "ok", frame: frameDto(row, deps) });
      }

      case "hide":
      case "show": {
        const { frameId } = body;
        if (!isUuid(frameId)) return fail(400, "invalid_frame_id");
        const row = await deps.db.getFrame(frameId);
        if (!row) return fail(404, "frame_not_found");
        await deps.db.updateFrame(frameId, { is_active: action === "show" });
        return json(200, { status: "ok" });
      }

      default:
        return fail(400, "invalid_action");
    }
  });
}

// ── cleanup ─────────────────────────────────────────────────────────────
// Called hourly by pg_cron. Deletes files through the Storage API (deleting
// storage.objects rows in SQL would leave the actual files behind).

export function handleCleanup(req: Request, deps: Deps): Promise<Response> {
  return serve(req, ["POST"], async () => {
    if (!deps.env.CLEANUP_TOKEN) return fail(500, "server_misconfigured");
    if (!sameSecret(req.headers.get("x-cleanup-token"), deps.env.CLEANUP_TOKEN)) {
      return fail(401, "unauthorized");
    }

    const now = deps.now();
    const giveUpBefore = new Date(now.getTime() - UNUPLOADED_GIVE_UP_MS).toISOString();
    let purged = 0;

    // Bounded loop so one run can't exceed the function's time limit.
    for (let round = 0; round < 10; round++) {
      const rows = await deps.db.listSessionsToPurge(now.toISOString(), giveUpBefore, 200);
      if (rows.length === 0) break;

      const paths = rows.flatMap((r) => [r.photo_path, r.video_path].filter((p): p is string => !!p));
      if (paths.length) await deps.storage.remove(SESSIONS_BUCKET, paths);
      for (const r of rows) await deps.db.updateSession(r.id, { deleted_at: now.toISOString() });
      purged += rows.length;
    }

    return json(200, { status: "ok", purged });
  });
}
