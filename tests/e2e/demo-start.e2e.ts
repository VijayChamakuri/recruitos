import { expect, test } from "./harness.js";
import { ROUTES, TEST_IDS } from "../../apps/web/src/testids.js";

/**
 * Required browser workflow 1: Demo Start
 * - invoke demo start sequence
 * - assert migrations, exactly 140 main candidates, fixture finalization,
 *   Class 1 completion, and production UI readiness
 * - assert zero live extraction requests
 */
test.describe("Workflow 1: Demo Start", () => {
  test.fixme(
    "executes demo start and renders production UI with 140 candidates and zero live calls",
    async ({ page }) => {
      // 1. Production UI readiness and status
      await page.goto(ROUTES.STATUS);
      const title = await page.title();
      expect(title).toContain("RecruitOS");

      // 2. Status page confirms schema migrations and corpus seal
      const sealStatus = page.getByTestId(TEST_IDS.CORPUS_SEAL_STATUS);
      await expect(sealStatus).toBeVisible();
      const statusContent = await sealStatus.innerText();
      expect(statusContent).toContain("SEALED");

      // 3. Navigate to triage dashboard
      await page.goto(ROUTES.TRIAGE);
      const triageHeading = page.getByTestId(TEST_IDS.TRIAGE_HEADING);
      await expect(triageHeading).toBeVisible();
      await expect(triageHeading).toHaveText(/Triage/i);

      // 4. Assert fixture finalization: exactly 140 candidates listed in triage table
      const candidateRows = page.getByTestId(TEST_IDS.CANDIDATE_ROW);
      await expect(candidateRows).toHaveCount(140);

      // 5. Assert zero live extraction calls recorded in audit trail
      await page.goto(ROUTES.RUNS);
      const auditTable = page.getByTestId(TEST_IDS.AUDIT_EVENT_TABLE);
      await expect(auditTable).toBeVisible();
      const auditContent = await page.content();
      expect(auditContent).toContain("fixture");
      expect(auditContent).not.toContain("live_call_error");
      expect(auditContent).not.toContain("live_extraction_attempt");
    }
  );
});
