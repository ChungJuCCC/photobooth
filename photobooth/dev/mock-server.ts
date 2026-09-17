// Local stand-in for Supabase + Vercel, running the real function handlers.
//
//   node dev/mock-server.ts            → http://localhost:8787
//
//   /app/            tablet app (app/www)
//   /s?id=…          guest page (web/)
//   /functions/v1/*  Edge Functions (real handlers, in-memory data)
//
// Dev controls (for testing the offline and expiry paths):
//   POST /__dev/offline?on=1|0   functions answer with a dropped connection
//   POST /__dev/advance?hours=N  move the server clock forward
//   POST /__dev/cleanup          run the hourly cleanup now
//   GET  /__dev/state            sessions, frames, stored objects

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createMemoryDeps } from "./memory-deps.ts";
import {
  corsHeaders,
  handleCleanup,
  handleCompleteUpload,
  handleCreateUpload,
  handleGetSession,
  handleListFrames,
  handleManageFrames,
} from "../supabase/functions/_shared/handlers.ts";

const PORT = Number(process.env.PORT ?? 8787);
const ORIGIN = `http://localhost:${PORT}`;
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

let clockOffsetMs = 0;
let offline = false;

const mem = createMemoryDeps({
  baseUrl: ORIGIN,
  now: () => new Date(Date.now() + clockOffsetMs),
  adminPin: process.env.ADMIN_PIN ?? "1234",
});

const functions: Record<string, (req: Request, deps: typeof mem.deps) => Promise<Response>> = {
  "create-upload": handleCreateUpload,
  "complete-upload": handleCompleteUpload,
  "get-session": handleGetSession,
  "list-frames": handleListFrames,
  "manage-frames": handleManageFrames,
  cleanup: handleCleanup,
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function devConfig(target: "app" | "web"): string {
  const common = {
    functionsUrl: `${ORIGIN}/functions/v1`,
    publishableKey: "sb_publishable_dev",
  };
  const config = target === "app"
    ? { ...common, boothKey: "dev-booth-key", guestPageUrl: `${ORIGIN}/s`, eventName: "", dev: true }
    : { ...common, eventName: "" };
  const name = target === "app" ? "BOOTH_CONFIG" : "GUEST_CONFIG";
  return `window.${name} = ${JSON.stringify(config, null, 2)};\n`;
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

function send(res: ServerResponse, status: number, body: string | Uint8Array, headers: Record<string, string> = {}) {
  res.writeHead(status, { ...corsHeaders, "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS", ...headers });
  res.end(body);
}

async function serveStatic(res: ServerResponse, baseDir: string, relPath: string) {
  const base = resolve(ROOT, baseDir);
  let file = normalize(join(base, relPath));
  if (!file.startsWith(base + sep) && file !== base) return send(res, 403, "forbidden");
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const data = await readFile(file);
    send(res, 200, data, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  } catch {
    send(res, 404, "not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", ORIGIN);
  const path = url.pathname;

  try {
    if (req.method === "OPTIONS") return send(res, 204, "");

    // ── dev controls ──────────────────────────────────────────────────
    if (path === "/__dev/offline") {
      offline = url.searchParams.get("on") === "1";
      return send(res, 200, JSON.stringify({ offline }), { "Content-Type": "application/json" });
    }
    if (path === "/__dev/advance") {
      clockOffsetMs += Number(url.searchParams.get("hours") ?? 0) * 3600_000;
      return send(res, 200, JSON.stringify({ now: mem.deps.now().toISOString() }), { "Content-Type": "application/json" });
    }
    if (path === "/__dev/cleanup") {
      const r = await handleCleanup(
        new Request(`${ORIGIN}/functions/v1/cleanup`, { method: "POST", headers: { "x-cleanup-token": "dev-cleanup-token" } }),
        mem.deps,
      );
      return send(res, r.status, await r.text(), { "Content-Type": "application/json" });
    }
    if (path === "/__dev/state") {
      const state = {
        now: mem.deps.now().toISOString(),
        offline,
        sessions: [...mem.sessions.values()],
        frames: [...mem.frames.values()],
        objects: [...mem.objects.entries()].map(([k, v]) => ({ key: k, type: v.type, bytes: v.bytes.length })),
      };
      return send(res, 200, JSON.stringify(state, null, 2), { "Content-Type": "application/json" });
    }

    // ── Edge Functions ────────────────────────────────────────────────
    if (path.startsWith("/functions/v1/")) {
      if (offline) {
        req.socket.destroy();
        return;
      }
      const name = path.slice("/functions/v1/".length);
      const handler = functions[name];
      if (!handler) return send(res, 404, JSON.stringify({ error: "function_not_found" }));
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
      const request = new Request(url, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body,
      });
      const response = await handler(request, mem.deps);
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => (headers[k] = v));
      return send(res, response.status, new Uint8Array(await response.arrayBuffer()), headers);
    }

    // ── Storage emulation ─────────────────────────────────────────────
    if (path.startsWith("/__storage/upload/") && req.method === "PUT") {
      if (offline) {
        req.socket.destroy();
        return;
      }
      const token = path.split("/").pop()!;
      const type = String(req.headers["content-type"] ?? "application/octet-stream").split(";")[0];
      const status = mem.storageHttp.upload(token, await readBody(req), type);
      return send(res, status, JSON.stringify(status === 200 ? { Key: token } : { error: "invalid_token" }), {
        "Content-Type": "application/json",
      });
    }
    if (path.startsWith("/__storage/signed/")) {
      const obj = mem.storageHttp.readSigned(path.split("/").pop()!);
      if (!obj) return send(res, 400, JSON.stringify({ error: "InvalidJWT", message: "jwt expired" }));
      return send(res, 200, obj.bytes, { "Content-Type": obj.type });
    }
    if (path.startsWith("/__storage/public/")) {
      const [bucket, ...rest] = path.slice("/__storage/public/".length).split("/");
      const obj = mem.storageHttp.readPublic(bucket, rest.join("/"));
      if (!obj) return send(res, 404, "not found");
      return send(res, 200, obj.bytes, { "Content-Type": obj.type });
    }

    // ── static sites ──────────────────────────────────────────────────
    if (path === "/app/config.js") return send(res, 200, devConfig("app"), { "Content-Type": MIME[".js"] });
    if (path === "/config.js") return send(res, 200, devConfig("web"), { "Content-Type": MIME[".js"] });
    if (path === "/app" || path.startsWith("/app/")) return serveStatic(res, "app/www", path.slice(4) || "/");
    if (path === "/s") return serveStatic(res, "web", "index.html"); // same rewrite as web/vercel.json
    return serveStatic(res, "web", path);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, "mock server error");
  }
});

server.listen(PORT, () => {
  console.log(`mock server on ${ORIGIN}`);
  console.log(`  tablet app  ${ORIGIN}/app/`);
  console.log(`  guest page  ${ORIGIN}/s?id=<session-id>`);
  console.log(`  admin PIN   ${process.env.ADMIN_PIN ?? "1234"}`);
});
