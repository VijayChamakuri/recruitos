import http from "node:http";
import { describe, expect, it } from "vitest";
import {
  BodyTooLargeError,
  MAXIMUM_FORM_BODY_BYTES,
  createWebServer,
  readFormBody
} from "./server.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected a TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

describe("web HTTP body parsing", () => {
  it("parses POST form bodies and ignores GET bodies", async () => {
    const post = {
      method: "POST",
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("rationale=need+overlay");
      }
    } as unknown as http.IncomingMessage;
    const parsed = await readFormBody(post);
    expect(parsed.get("rationale")).toBe("need overlay");
    const get = { method: "GET" } as http.IncomingMessage;
    expect((await readFormBody(get)).toString()).toBe("");
  });

  it("rejects oversized POST bodies", async () => {
    const huge = {
      method: "POST",
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(MAXIMUM_FORM_BODY_BYTES + 1);
      }
    } as unknown as http.IncomingMessage;
    await expect(readFormBody(huge)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("returns 413 for oversized POST and serves tokens.css without a composition", async () => {
    const server = createWebServer();
    const port = await listen(server);
    try {
      const tokens = await fetch(`http://127.0.0.1:${port}/tokens.css`);
      expect(tokens.status).toBe(200);
      expect(await tokens.text()).toContain("--surface-paper");

      const oversized = await fetch(`http://127.0.0.1:${port}/actions/request-re-extraction`, {
        method: "POST",
        body: "x".repeat(MAXIMUM_FORM_BODY_BYTES + 1),
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      });
      expect(oversized.status).toBe(413);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
