// Railway minimal test
import http from "http";

const PORT = process.env.PORT || 8080;
const startedAt = Date.now();

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    ok: true,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    port: PORT,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    cwd: process.cwd(),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
  }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`READY port=${PORT} node=${process.version}`);
});

// Crash handlers
process.on("uncaughtException", (e) => {
  console.error("CRASH:", e.message);
  process.exit(1);
});
