import { describe, expect, it } from "vitest";
import {
  DEFAULT_APPEARANCE,
  hrefWithAppearance,
  packetHref,
  parseAppearance
} from "./appearance.js";

describe("URL appearance", () => {
  it("defaults to light theme and default density", () => {
    expect(parseAppearance(new URLSearchParams())).toEqual(DEFAULT_APPEARANCE);
  });

  it("falls back to deterministic defaults for invalid values", () => {
    expect(parseAppearance(new URLSearchParams("theme=neon&density=huge"))).toEqual(
      DEFAULT_APPEARANCE
    );
  });

  it("accepts dark and compact", () => {
    expect(parseAppearance(new URLSearchParams("theme=dark&density=compact"))).toEqual({
      theme: "dark",
      density: "compact"
    });
  });

  it("builds packet hrefs that preserve appearance", () => {
    const href = packetHref("demo/route-1", { theme: "dark", density: "comfortable" });
    expect(href).toContain("/packet/demo%2Froute-1");
    expect(href).toContain("theme=dark");
    expect(href).toContain("density=comfortable");
    expect(hrefWithAppearance("/triage", DEFAULT_APPEARANCE)).toBe(
      "/triage?theme=light&density=default"
    );
  });

  it("preserves non-appearance query parameters when replacing theme", () => {
    const href = hrefWithAppearance(
      "/packet/demo-1",
      { theme: "dark", density: "compact" },
      new URLSearchParams("result=hist-9&theme=light&density=default")
    );
    expect(href).toContain("result=hist-9");
    expect(href).toContain("theme=dark");
    expect(href).toContain("density=compact");
    expect(href).not.toContain("theme=light");
  });

  it("includes result on packet hrefs", () => {
    const href = packetHref("cand-1", DEFAULT_APPEARANCE, "result-9");
    expect(href).toContain("/packet/cand-1");
    expect(href).toContain("result=result-9");
    expect(href).toContain("theme=light");
  });
});
