import http from "node:http";

const port = Number(process.env.PORT ?? 8080);
const server = http.createServer((request, response) => {
  if (request.url === "/health" || request.url === "/healthz") {
    response.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ status: "unavailable", mode: "health-failure-fixture" }));
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end("<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>Preview</title><main><h1>课程 Preview</h1><p>健康检查失败 Fixture。</p></main>");
});

server.listen(port, "0.0.0.0");
