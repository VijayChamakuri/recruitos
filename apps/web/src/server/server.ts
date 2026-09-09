import http from "node:http";
import { openExplicitDatabaseComposition, setServerComposition } from "./composition.js";
import { setCorrectionFixtureMode } from "./correction-mode.js";
import { serveWebFont } from "./fonts.js";
import { handleRequest } from "./handlers.js";
import { parseWebServerOptions } from "./options.js";

export { parseWebServerOptions } from "./options.js";

export const MAXIMUM_FORM_BODY_BYTES = 65_536;

export async function readFormBody(req: http.IncomingMessage): Promise<URLSearchParams> {
  if (req.method !== "POST") {
    return new URLSearchParams();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAXIMUM_FORM_BODY_BYTES) {
      throw new BodyTooLargeError();
    }
    chunks.push(buf);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export class BodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "BodyTooLargeError";
  }
}

export function createWebServer(): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const font = serveWebFont(url.pathname);
      if (font !== null) {
        res.writeHead(font.statusCode, font.headers);
        res.end(font.body);
        return;
      }
      const body = await readFormBody(req);
      const response = await handleRequest(url.pathname, url.searchParams, {
        method: req.method ?? "GET",
        body
      });

      res.writeHead(response.statusCode, response.headers);
      res.end(response.body);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Request body too large");
        return;
      }
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
  setCorrectionFixtureMode(parsed.value.correctionFixture);
  const server = createWebServer();
  server.listen(parsed.value.port, parsed.value.host, () => {
    const url = browserUrl(parsed.value.host, parsed.value.port);
    // eslint-disable-next-line no-console
    console.log(`RecruitOS web serving ${url}`);
    // eslint-disable-next-line no-console
    console.log(`database ${parsed.value.databasePath}`);
    if (parsed.value.correctionFixture) {
      // eslint-disable-next-line no-console
      console.log(
        "Fixture correction mutations enabled. Browser does not supply extracted facts or the system actor."
      );
    }
  });
}
