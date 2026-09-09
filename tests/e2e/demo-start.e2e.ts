import { expect, test } from "./harness.js";
import { ROUTES, TEST_IDS } from "../../apps/web/src/testids.js";

const ROUTE_1_SOURCE_KEY = "demo/route-1-scored";
const ROUTE_4_SOURCE_KEY = "demo/route-4-reviewable-failure";

/**
 * Required browser workflow 1: Demo Start
 * Seven-candidate proving corpus (this phase). 140-candidate corpus is deferred.
 */
test.describe("Workflow 1: Demo Start", () => {
  test("executes demo start and renders the seven-candidate triage queue with zero live calls", async ({
    page,
    testEnvironment
  }) => {
    const externalRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
        externalRequests.push(request.url());
      }
    });

    await page.goto(`${ROUTES.TRIAGE}?theme=light&density=default`);
    await expect(page.getByTestId(TEST_IDS.TRIAGE_HEADING)).toBeVisible();
    await expect(page.getByTestId(TEST_IDS.TRIAGE_HEADING)).toHaveText(/Triage/i);
    await expect(page.getByTestId(TEST_IDS.SYNTHETIC_DATA_PILL).first()).toHaveText(
      "SYNTHETIC DATA"
    );

    const candidateRows = page.getByTestId(TEST_IDS.CANDIDATE_ROW);
    await expect(candidateRows).toHaveCount(7);
    await expect(page.getByText(ROUTE_1_SOURCE_KEY)).toBeVisible();
    await expect(page.getByText(ROUTE_4_SOURCE_KEY)).toBeVisible();
    await expect(page.getByText("rejected_hard_requirement", { exact: true })).toBeVisible();
    await expect(page.getByText("escalated").first()).toBeVisible();
    await expect(page.getByText("scored").first()).toBeVisible();
    await expect(page.getByText("57.1% of corpus")).toBeVisible();
    await expect(page.locator("body")).not.toContainText("128.6%");
    const html = await page.content();
    expect(html).toContain("@font-face");
    expect(html).not.toContain("fonts.googleapis");
    expect(html).not.toMatch(/run-\d{10,}/);

    expect(externalRequests).toEqual([]);
    expect(testEnvironment.dbPath.length).toBeGreaterThan(0);
  });
});
