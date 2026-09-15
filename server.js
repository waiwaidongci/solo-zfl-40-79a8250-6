// 入口：加载数据、启动恢复（漏检标记）、静态页与 API
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonStore } from "./src/store.js";
import { buildSeed } from "./src/seed.js";
import { createApp } from "./src/routes.js";
import { sweepMissedInspections } from "./src/domain.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const dbPath = process.env.DB_PATH || join(__dirname, "data", "darkroom-monitor.json");
const port = Number(process.env.PORT || 3040);

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

export async function startServer({ listen = true } = {}) {
  const store = new JsonStore(dbPath, () => buildSeed({ now: new Date() }));
  await store.load();
  // 重启恢复：把过期未交的巡检标成漏检
  await store.mutate((d) => ({ missed: sweepMissedInspections(d, { now: new Date() }) }));
  const api = createApp(store);

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, "http://x").pathname;
    if (pathname.startsWith("/api/")) return api(req, res);
    // 静态页
    let file = pathname === "/" ? "/index.html" : pathname;
    const fp = join(__dirname, "public", file);
    if (!fp.startsWith(join(__dirname, "public")) || !existsSync(fp)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("not found");
    }
    res.writeHead(200, { "Content-Type": MIME[extname(fp)] || "application/octet-stream" });
    res.end(await readFile(fp));
  });

  if (listen) {
    await new Promise((resolve) => server.listen(port, resolve));
    console.log(`蓝晒暗房安全与环境监测台 http://localhost:${port}（数据：${dbPath}）`);
  }
  return { server, store };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer();
}
