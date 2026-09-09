import http from "node:http";
import { openExplicitDatabaseComposition, setServerComposition } from "./composition.js";
import { handleRequest } from "./handlers.js";
import { parseWebServerOptions } from "./options.js";

export { parseWebServerOptions } from "./options.js";

export function createWebServer(): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const response = await handleRequest(url.pathname, url.searchParams);

      res.writeHead(response.statusCode, response.headers);
      res.end(response.body);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Internal Server Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

export function browserUrl(host: string, port: number): string {
  return `http://${host}:${port}/triage?theme=light&density=default`;
}

function failStartup(message: string): never {
  // eslint-disable-next-line no-console
  console.error(message);
  process.exit(1);
}

if (process.argv[1]?.endsWith("server.js")) {
  const parsed = parseWebServerOptions(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    failStartup(parsed.error);
  }

  const opened = openExplicitDatabaseComposition(parsed.value.databasePath);
  if (!opened.ok) {
    failStartup(
      `RecruitOS web could not open the database: [${opened.error.code}] ${opened.error.message}`
    );
  }

  setServerComposition(opened.value);
  const server = createWebServer();
  server.listen(parsed.value.port, parsed.value.host, () => {
    const url = browserUrl(parsed.value.host, parsed.value.port);
    // eslint-disable-next-line no-console
    console.log(`RecruitOS web serving ${url}`);
    // eslint-disable-next-line no-console
    console.log(`database ${parsed.value.databasePath}`);
  });
}
