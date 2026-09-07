import http from "node:http";
import { handleRequest } from "./handlers.js";

export function createWebServer(): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const response = await handleRequest(url.pathname, url.searchParams);

      res.writeHead(response.statusCode, response.headers);
      res.end(response.body);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Internal Server Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

// If started directly via `node dist/server/server.js`
if (process.argv[1]?.endsWith("server.js")) {
  const port = Number.parseInt(process.env["PORT"] ?? "3000", 10);
  const server = createWebServer();
  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`RecruitOS Web Shell running at http://localhost:${port}`);
  });
}
