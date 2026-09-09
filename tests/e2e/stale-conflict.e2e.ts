import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test } from "./harness.js";
import { ROUTES, TEST_IDS } from "../../apps/web/src/testids.js";

const ROUTE_4_SOURCE_KEY = "demo/route-4-reviewable-failure";

function countRequestReExtractionActions(dbPath: string): number {
  const repoRoot = resolve(import.meta.dirname, "../..");
  const require = createRequire(resolve(repoRoot, "packages/runtime/package.json"));
  const Database = require("better-sqlite3") as {
    new (
      filename: string,
      options?: { readonly?: boolean; fileMustExist?: boolean }
    ): {
      prepare: (sql: string) => { get: () => { n: number } };
      close: () => void;
    };
  };
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `SELECT COUNT(*) AS n FROM resolution_action WHERE action_kind = 'request_re_extraction'`
      )
      .get().n;
  } finally {
    db.close();
  }
}

/**
 * Required browser workflow 4: two browser contexts submit the same open task.
 * The second receives a stale conflict and does not mutate again.
 */
test.describe("Workflow 4: Stale conflict handling", () => {
  test.use({ correctionFixture: true });

  test("rejects a stale second submission and keeps the second form intact", async ({
    browser,
    testEnvironment
  }) => {
    const packetPath = `${ROUTES.REVIEW}?theme=light&density=default`;
    const contextA = await browser.newContext({ baseURL: testEnvironment.serverUrl });
    const contextB = await browser.newContext({ baseURL: testEnvironment.serverUrl });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await pageA.goto(packetPath);
      const rowA = pageA.locator("tr").filter({ hasText: ROUTE_4_SOURCE_KEY });
      await expect(rowA).toBeVisible();
      await rowA.getByRole("link", { name: ROUTE_4_SOURCE_KEY }).click();
      await expect(pageA.getByTestId(TEST_IDS.RESOLUTION_FORM)).toBeVisible();

      await pageB.goto(packetPath);
      const rowB = pageB.locator("tr").filter({ hasText: ROUTE_4_SOURCE_KEY });
      await expect(rowB).toBeVisible();
      await rowB.getByRole("link", { name: ROUTE_4_SOURCE_KEY }).click();
      await expect(pageB.getByTestId(TEST_IDS.RESOLUTION_FORM)).toBeVisible();

      await pageA.getByTestId(TEST_IDS.RATIONALE_INPUT).fill("Context A records re-extraction");
      await pageB.getByTestId(TEST_IDS.RATIONALE_INPUT).fill("Context B keeps this stale rationale");

      await pageA.getByTestId(TEST_IDS.SUBMIT_RESOLUTION_BTN).click();
      await expect(pageA.getByTestId(TEST_IDS.TOAST_SUCCESS)).toBeVisible();
      expect(countRequestReExtractionActions(testEnvironment.dbPath)).toBe(1);

      await pageB.getByTestId(TEST_IDS.SUBMIT_RESOLUTION_BTN).click();
      const conflictBanner = pageB.getByTestId(TEST_IDS.CONFLICT_ERROR_BANNER);
      await expect(conflictBanner).toBeVisible();
      const errorText = await conflictBanner.innerText();
      expect(errorText.toLowerCase()).toContain("stale");
      await expect(pageB.getByTestId(TEST_IDS.RATIONALE_INPUT)).toHaveValue(
        "Context B keeps this stale rationale"
      );
      await expect(pageB.getByTestId(TEST_IDS.SUBMIT_RESOLUTION_BTN)).toBeDisabled();
      expect(countRequestReExtractionActions(testEnvironment.dbPath)).toBe(1);
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
