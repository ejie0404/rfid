import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const root = fileURLToPath(new URL("../", import.meta.url));
const outputs = [
  ["control-web", 3000],
  ["guard-web", 3001],
  ["resident-web", 3002],
];
for (const [name] of outputs)
  if (!existsSync(resolve(root, "apps", name, "out/index.html")))
    throw new Error("Run npm run build first.");
const api = spawn(process.execPath, ["apps/api/dist/main.js"], {
  cwd: root,
  // The preview is a development mode by definition, so the mode is set here rather than
  // inherited: a production NODE_ENV in the shell would otherwise refuse to start.
  env: { ...process.env, NODE_ENV: "development", SMARTGATE_DEMO: "true" },
  stdio: "inherit",
});
const servers = [];
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
  ".woff2": "font/woff2",
};
for (const [name, port] of outputs) {
  const directory = resolve(root, "apps", name, "out");
  const server = createServer(async (req, res) => {
    try {
      if (!["127.0.0.1", "localhost"].includes((req.headers.host || "").split(":")[0])) {
        res.writeHead(403);
        res.end();
        return;
      }
      const url = new URL(req.url, "http://localhost");
      let file = resolve(directory, "." + decodeURIComponent(url.pathname));
      if (file !== directory && !file.startsWith(directory + sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const info = await stat(file);
      if (info.isDirectory()) file = resolve(file, "index.html");
      const data = await readFile(file);
      res.writeHead(200, {
        "Content-Type": mime[extname(file)] || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  server.on("error", (error) => {
    console.error(name + ": " + error.message);
    process.exitCode = 1;
    stop();
  });
  server.listen(port, "127.0.0.1", () => console.log(name + ": http://127.0.0.1:" + port));
  servers.push(server);
}
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const server of servers) server.close();
  api.kill("SIGTERM");
}
api.on("exit", (code) => {
  stop();
  process.exitCode ||= code || 0;
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
