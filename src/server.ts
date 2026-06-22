import http from "http";
const PORT = parseInt(process.env.PORT || "3100");

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify({ status: "ok", name: "CodeClash" }));
});

server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`LISTEN:${PORT}\n`);
});
