import http from "http";
const PORT = parseInt(process.env.PORT || "3100");
http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok" }));
}).listen(PORT, "0.0.0.0", () => console.log(`Running on ${PORT}`));
