// In-memory implementation of Db and Storage for tests and the local mock
// server. The PIN lock rules mirror public.check_admin_pin() in the migration.

import type { Db, Deps, PinCheck, Storage } from "../supabase/functions/_shared/handlers.ts";
import type { FrameRow, SessionRow } from "../supabase/functions/_shared/logic.ts";

export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCK_MS = 10 * 60 * 1000;

type StoredObject = { bytes: Uint8Array; type: string };
type Ticket = { bucket: string; path: string; expiresAt: number };

export type MemoryOptions = {
  baseUrl: string;
  now?: () => Date;
  env?: Deps["env"];
  adminPin?: string | null;
};

export function createMemoryDeps(options: MemoryOptions) {
  const now = options.now ?? (() => new Date());
  const sessions = new Map<string, SessionRow>();
  const frames = new Map<string, FrameRow>();
  const objects = new Map<string, StoredObject>();
  const uploadTickets = new Map<string, Ticket>();
  const readTickets = new Map<string, Ticket>();
  const admin = { pin: options.adminPin ?? null, failed: 0, lockedUntil: 0 };

  const key = (bucket: string, path: string) => `${bucket}/${path}`;
  const token = () => crypto.randomUUID().replace(/-/g, "");

  const db: Db = {
    async getSession(id) {
      const row = sessions.get(id);
      return row ? { ...row } : null;
    },
    async insertSession(row) {
      if (sessions.has(row.id)) throw new Error("duplicate session");
      sessions.set(row.id, { ...row });
    },
    async updateSession(id, patch) {
      const row = sessions.get(id);
      if (row) sessions.set(id, { ...row, ...patch });
    },
    async countSessionsSince(deviceId, sinceIso) {
      const since = Date.parse(sinceIso);
      return [...sessions.values()].filter((s) => s.device_id === deviceId && Date.parse(s.created_at) >= since).length;
    },
    async listSessionsToPurge(nowIso, giveUpBeforeIso, limit) {
      const t = Date.parse(nowIso);
      const giveUp = Date.parse(giveUpBeforeIso);
      return [...sessions.values()]
        .filter((s) =>
          !s.deleted_at &&
          ((s.expires_at && Date.parse(s.expires_at) <= t) || (!s.uploaded_at && Date.parse(s.created_at) < giveUp))
        )
        .slice(0, limit)
        .map((s) => ({ ...s }));
    },
    async listFrames(includeHidden) {
      return [...frames.values()]
        .filter((f) => includeHidden || f.is_active)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((f) => ({ ...f }));
    },
    async getFrame(id) {
      const row = frames.get(id);
      return row ? { ...row } : null;
    },
    async insertFrame(row) {
      frames.set(row.id, { ...row });
    },
    async updateFrame(id, patch) {
      const row = frames.get(id);
      if (row) frames.set(id, { ...row, ...patch });
    },
    async checkAdminPin(pin): Promise<PinCheck> {
      const t = now().getTime();
      if (!admin.pin) return { result: "unset" };
      if (admin.lockedUntil > t) return { result: "locked", lockedUntil: new Date(admin.lockedUntil).toISOString() };
      if (admin.lockedUntil && admin.lockedUntil <= t) {
        admin.lockedUntil = 0;
        admin.failed = 0;
      }
      if (pin === admin.pin) {
        admin.failed = 0;
        return { result: "ok" };
      }
      admin.failed += 1;
      if (admin.failed >= PIN_MAX_ATTEMPTS) {
        admin.lockedUntil = t + PIN_LOCK_MS;
        return { result: "locked", lockedUntil: new Date(admin.lockedUntil).toISOString() };
      }
      return { result: "wrong", remaining: PIN_MAX_ATTEMPTS - admin.failed };
    },
  };

  const storage: Storage = {
    async createSignedUploadUrl(bucket, path) {
      const t = token();
      uploadTickets.set(t, { bucket, path, expiresAt: now().getTime() + 2 * 60 * 60 * 1000 });
      return `${options.baseUrl}/__storage/upload/${t}`;
    },
    async createSignedUrl(bucket, path, seconds) {
      const t = token();
      readTickets.set(t, { bucket, path, expiresAt: now().getTime() + seconds * 1000 });
      return `${options.baseUrl}/__storage/signed/${t}`;
    },
    async exists(bucket, path) {
      return objects.has(key(bucket, path));
    },
    async download(bucket, path) {
      return objects.get(key(bucket, path))?.bytes ?? null;
    },
    async remove(bucket, paths) {
      for (const p of paths) objects.delete(key(bucket, p));
    },
    publicUrl(bucket, path) {
      return `${options.baseUrl}/__storage/public/${bucket}/${path}`;
    },
  };

  const deps: Deps = {
    db,
    storage,
    env: options.env ?? { BOOTH_KEY: "dev-booth-key", CLEANUP_TOKEN: "dev-cleanup-token" },
    now,
    newId: () => crypto.randomUUID(),
  };

  // Emulates the parts of Supabase Storage the clients talk to directly.
  const storageHttp = {
    upload(t: string, bytes: Uint8Array, type: string): number {
      const ticket = uploadTickets.get(t);
      if (!ticket || ticket.expiresAt < now().getTime()) return 403;
      objects.set(key(ticket.bucket, ticket.path), { bytes, type });
      return 200;
    },
    readSigned(t: string): StoredObject | null {
      const ticket = readTickets.get(t);
      if (!ticket || ticket.expiresAt < now().getTime()) return null;
      return objects.get(key(ticket.bucket, ticket.path)) ?? null;
    },
    readPublic(bucket: string, path: string): StoredObject | null {
      if (bucket !== "frames") return null;
      return objects.get(key(bucket, path)) ?? null;
    },
  };

  return { deps, storageHttp, sessions, frames, objects, admin };
}
