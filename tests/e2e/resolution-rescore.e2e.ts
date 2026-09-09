import { createRequire } from "node:module";
import { resolve } from "node:path";
import { assertFixtureOnlyExtraction, expect, test } from "./harness.js";
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
 * Required browser workflow 3: fixture correction request, overlay completion,
 * superseding packet, and preserved historical packet.
 */
test.describe("Workflow 3: Fixture correction", () => {
  test.use({ correctionFixture: true });

  test("requests re-extraction, completes the fixture overlay, and keeps the original packet", async ({
    page,
    testEnvironment
  }) => {
    await page.goto(`${ROUTES.REVIEW}?theme=light&density=default`);
    const taskRow = page.locator("tr").filter({ hasText: ROUTE_4_SOURCE_KEY });
    await expect(taskRow).toBeVisible();
    await expect(taskRow).toContainText("open");
    await taskRow.getByRole("link", { name: ROUTE_4_SOURCE_KEY }).click();

    await expect(page.getByTestId(TEST_IDS.PACKET_VIEW)).toBeVisible();
    await expect(page.getByTestId(TEST_IDS.TASK_INSPECTOR)).toBeVisible();
    const originalResultId = await page.getByTestId(TEST_IDS.PACKET_VIEW).getAttribute("data-result-id");
    const candidateId = await page.getByTestId(TEST_IDS.PACKET_VIEW).getAttribute("data-candidate-id");
    expect(originalResultId).toBeTruthy();
    expect(candidateId).toBeTruthy();

    await expect(page.getByTestId(TEST_IDS.RESOLUTION_FORM)).toBeVisible();
    await expect(page.locator("select[name='actorId']")).toHaveCount(0);
    await page.getByTestId(TEST_IDS.RATIONALE_INPUT).fill("Need the fixture overlay for route 4");
    await page.getByTestId(TEST_IDS.SUBMIT_RESOLUTION_BTN).click();

    await expect(page.getByTestId(TEST_IDS.TOAST_SUCCESS)).toBeVisible();
    await expect(page.getByTestId(TEST_IDS.COMPLETE_FIXTURE_BTN)).toBeVisible();
    await page.getByTestId(TEST_IDS.COMPLETE_FIXTURE_BTN).click();

    await expect(page.getByTestId(TEST_IDS.PACKET_VIEW)).toHaveAttribute("data-result-kind", "correction");
    await expect(page.locator("main")).toContainText("result kind: correction");
    await expect(page.locator("main")).toContainText("scored");
    await expect(page.locator("main")).toContainText("review_required");
    await expect(page.getByTestId(TEST_IDS.SUPERSEDING_BADGE)).toBeVisible();
    await expect(page.getByTestId(TEST_IDS.PRIOR_VERSION_LINK)).toBeVisible();

    await page.getByTestId(TEST_IDS.PRIOR_VERSION_LINK).click();
    await expect(page.getByTestId(TEST_IDS.PACKET_INSPECTING_LABEL)).toContainText("historical result");
    await expect(page.locator("main")).toContainText("escalated");
    await expect(page.getByTestId(TEST_IDS.ROUTING_REASON_TAG("assessment_unavailable"))).toBeVisible();

    await page.goto(
      `${ROUTES.PACKET(candidateId ?? "")}?theme=light&density=default&result=${originalResultId}`
    );
    await expect(page.getByTestId(TEST_IDS.PACKET_INSPECTING_LABEL)).toContainText("historical result");
    await expect(page.locator("main")).toContainText("escalated");

    assertFixtureOnlyExtraction(testEnvironment.dbPath);
    expect(countRequestReExtractionActions(testEnvironment.dbPath)).toBe(1);
  });
});
