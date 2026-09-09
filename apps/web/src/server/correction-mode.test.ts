import { afterEach, describe, expect, it } from "vitest";
import { isCorrectionFixtureMode, setCorrectionFixtureMode } from "./correction-mode.js";

describe("correction fixture mode", () => {
  afterEach(() => {
    setCorrectionFixtureMode(false);
  });

  it("defaults off and round-trips", () => {
    setCorrectionFixtureMode(false);
    expect(isCorrectionFixtureMode()).toBe(false);
    setCorrectionFixtureMode(true);
    expect(isCorrectionFixtureMode()).toBe(true);
    setCorrectionFixtureMode(false);
    expect(isCorrectionFixtureMode()).toBe(false);
  });
});
