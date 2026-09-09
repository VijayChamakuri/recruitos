import { describe, expect, it } from "vitest";
import { serveWebFont, WEB_FONT_FILES } from "./fonts.js";

describe("serveWebFont", () => {
  it("serves each committed Latin face as woff2", () => {
    expect(WEB_FONT_FILES).toHaveLength(6);
    for (const file of WEB_FONT_FILES) {
      const response = serveWebFont(`/fonts/${file}`);
      expect(response).not.toBeNull();
      if (response === null) return;
      expect(response.statusCode).toBe(200);
      expect(response.headers["Content-Type"]).toBe("font/woff2");
      expect(response.body.length).toBeGreaterThan(1000);
    }
  });

  it("rejects path traversal and unknown names", () => {
    expect(serveWebFont("/other")).toBeNull();
    expect(serveWebFont("/fonts/../package.json")?.statusCode).toBe(404);
    expect(serveWebFont("/fonts/missing.woff2")?.statusCode).toBe(404);
  });
});
