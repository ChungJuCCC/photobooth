// Pure rules shared by every function. No Deno or Supabase imports here,
// so the same file runs under Node's test runner and the local mock server.

export const RETENTION_MS = 24 * 60 * 60 * 1000;
export const UNUPLOADED_GIVE_UP_MS = 48 * 60 * 60 * 1000;
export const SIGNED_DOWNLOAD_SECONDS = 600;
export const SESSIONS_PER_DEVICE_PER_MINUTE = 30;

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
export const MAX_FRAME_BYTES = 10 * 1024 * 1024;

export const LAYOUT_SIZES = {
  vertical: { width: 591, height: 1772 },
  grid: { width: 1080, height: 1200 },
} as const;

export type LayoutKey = keyof typeof LAYOUT_SIZES;

export type SessionRow = {
  id: string;
  device_id: string;
  frame_id: string | null;
  photo_path: string;
  video_path: string | null;
  created_at: string;
  uploaded_at: string | null;
  expires_at: string | null;
  deleted_at: string | null;
};

export type FrameRow = {
  id: string;
  name: string;
  layout: LayoutKey;
  path: string;
  is_active: boolean;
  created_at: string;
};

export type SessionState = "invalid" | "pending" | "ready" | "expired";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PIN_RE = /^\d{4}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isDeviceId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_RE.test(value);
}

export function isPin(value: unknown): value is string {
  return typeof value === "string" && PIN_RE.test(value);
}

export function isLayout(value: unknown): value is LayoutKey {
  return value === "vertical" || value === "grid";
}

// A guest can only ever see one of four states. Deleted rows count as
// expired even if the timestamps say otherwise, so a purged session never
// flips back to "pending".
export function sessionState(id: string, row: SessionRow | null, now: Date): SessionState {
  if (!isUuid(id)) return "invalid";
  if (row?.deleted_at) return "expired";
  if (!row || !row.uploaded_at || !row.expires_at) return "pending";
  return now.getTime() < Date.parse(row.expires_at) ? "ready" : "expired";
}

export function expiresAtFrom(uploadedAt: Date): Date {
  return new Date(uploadedAt.getTime() + RETENTION_MS);
}

export function videoExtension(type: unknown): "mp4" | "webm" | null {
  if (type === "video/mp4") return "mp4";
  if (type === "video/webm") return "webm";
  return null;
}

export function sessionPaths(id: string, videoType: unknown) {
  const ext = videoExtension(videoType);
  return {
    photo: `${id}/photo.jpg`,
    video: ext ? `${id}/timelapse.${ext}` : null,
  };
}

export function cleanFrameName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim();
  return name.length >= 1 && name.length <= 30 ? name : null;
}

// Reads width and height from a PNG's IHDR chunk. Returns null for anything
// that isn't a PNG, so a renamed JPEG can't sneak in as a frame.
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return null;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return null;
  }
  const chunkType = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (chunkType !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function matchesLayout(size: { width: number; height: number }, layout: LayoutKey): boolean {
  const spec = LAYOUT_SIZES[layout];
  return size.width === spec.width && size.height === spec.height;
}

// Constant-time string comparison for shared secrets.
export function sameSecret(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
