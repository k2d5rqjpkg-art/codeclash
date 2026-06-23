import http from "node:http";
const PORT = parseInt(process.env.PORT || "3100");

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, port: PORT, node: process.version, cwd: process.cwd() }));
});

server.on("error", (e) => { process.stdout.write("ERR:" + e.message + "\n"); process.exit(1); });

server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write("READY:" + PORT + "\n");
});
