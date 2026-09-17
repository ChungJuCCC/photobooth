// Production dependencies: the only file that talks to Supabase directly.
// Runs on Supabase Edge Functions (Deno).

import { createClient } from "npm:@supabase/supabase-js@2";
import type { Db, Deps, PinCheck, Storage } from "./handlers.ts";
import type { FrameRow, SessionRow } from "./logic.ts";

function secretKey(): string {
  const keys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (keys) {
    try {
      const key = JSON.parse(keys)["default"];
      if (key) return key;
    } catch {
      // fall through to the legacy key
    }
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  throw new Error("No Supabase secret key found in the function environment");
}

function must<T>(result: { data: T; error: unknown }): T {
  if (result.error) throw result.error;
  return result.data;
}

export function supabaseDeps(): Deps {
  const client = createClient(Deno.env.get("SUPABASE_URL")!, secretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const db: Db = {
    async getSession(id) {
      return must(await client.from("sessions").select("*").eq("id", id).maybeSingle()) as SessionRow | null;
    },
    async insertSession(row) {
      must(await client.from("sessions").insert(row));
    },
    async updateSession(id, patch) {
      must(await client.from("sessions").update(patch).eq("id", id));
    },
    async countSessionsSince(deviceId, sinceIso) {
      const res = await client
        .from("sessions")
        .select("id", { count: "exact", head: true })
        .eq("device_id", deviceId)
        .gte("created_at", sinceIso);
      if (res.error) throw res.error;
      return res.count ?? 0;
    },
    async listSessionsToPurge(nowIso, giveUpBeforeIso, limit) {
      return must(
        await client.rpc("sessions_to_purge", { now_at: nowIso, give_up_before: giveUpBeforeIso, max_rows: limit }),
      ) as SessionRow[];
    },
    async listFrames(includeHidden) {
      let query = client.from("frames").select("*").order("created_at", { ascending: false });
      if (!includeHidden) query = query.eq("is_active", true);
      return must(await query) as FrameRow[];
    },
    async getFrame(id) {
      return must(await client.from("frames").select("*").eq("id", id).maybeSingle()) as FrameRow | null;
    },
    async insertFrame(row) {
      must(await client.from("frames").insert(row));
    },
    async updateFrame(id, patch) {
      must(await client.from("frames").update(patch).eq("id", id));
    },
    async checkAdminPin(pin) {
      const data = must(await client.rpc("check_admin_pin", { input_pin: pin })) as Record<string, unknown>;
      switch (data.result) {
        case "ok":
          return { result: "ok" };
        case "wrong":
          return { result: "wrong", remaining: Number(data.remaining) };
        case "locked":
          return { result: "locked", lockedUntil: String(data.locked_until) };
        default:
          return { result: "unset" } as PinCheck;
      }
    },
  };

  const storage: Storage = {
    async createSignedUploadUrl(bucket, path) {
      const data = must(await client.storage.from(bucket).createSignedUploadUrl(path, { upsert: true }));
      return data.signedUrl;
    },
    async createSignedUrl(bucket, path, seconds) {
      const data = must(await client.storage.from(bucket).createSignedUrl(path, seconds));
      return data.signedUrl;
    },
    async exists(bucket, path) {
      const slash = path.lastIndexOf("/");
      const folder = slash >= 0 ? path.slice(0, slash) : "";
      const name = path.slice(slash + 1);
      const list = must(await client.storage.from(bucket).list(folder, { search: name, limit: 10 }));
      return list.some((item) => item.name === name);
    },
    async download(bucket, path) {
      const res = await client.storage.from(bucket).download(path);
      if (res.error || !res.data) return null;
      return new Uint8Array(await res.data.arrayBuffer());
    },
    async remove(bucket, paths) {
      must(await client.storage.from(bucket).remove(paths));
    },
    publicUrl(bucket, path) {
      return client.storage.from(bucket).getPublicUrl(path).data.publicUrl;
    },
  };

  return {
    db,
    storage,
    env: { BOOTH_KEY: Deno.env.get("BOOTH_KEY"), CLEANUP_TOKEN: Deno.env.get("CLEANUP_TOKEN") },
    now: () => new Date(),
    newId: () => crypto.randomUUID(),
  };
}
