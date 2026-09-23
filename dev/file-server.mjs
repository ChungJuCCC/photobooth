// Temporary local file server used while setting up Supabase from the browser.
// Serves ./dist with CORS so the dashboard page can fetch the SQL and function code.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../dist", import.meta.url)));
const PORT = 8899;

createServer(async (req, res) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
  if (req.method === "OPTIONS") return res.writeHead(204, headers).end();
  const rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(ROOT + sep)) return res.writeHead(403, headers).end("no");
  try {
    const body = await readFile(file);
    const type = extname(file) === ".sql" ? "text/plain; charset=utf-8" : "text/plain; charset=utf-8";
    res.writeHead(200, { ...headers, "Content-Type": type }).end(body);
  } catch {
    res.writeHead(404, headers).end("not found");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`file server on http://localhost:${PORT} serving ${ROOT}`));
