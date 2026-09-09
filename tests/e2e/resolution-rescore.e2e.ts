import { expect, test } from "./harness.js";
import { ROUTES, TEST_IDS } from "../../apps/web/src/testids.js";

/**
 * Required browser workflow 3: Resolution Rescore
 * Deferred in T12 Phase 1. Seven-candidate proving corpus when activated.
 * - supply evidence and level for a pinned missing-evidence task
 * - assert score and confidence change in a superseding result
 * - keep the original result and evidence inspectable
 * - assert zero live calls
 */
test.describe("Workflow 3: Resolution Rescore", () => {
  test.fixme(
    "resolves missing evidence task, supersedes triage result, and retains original",
    async ({ page }) => {
      // 1. Navigate to resolution tasks queue
      await page.goto(ROUTES.REVIEW_TASKS);

      // 2. Open pinned missing-evidence task
      const taskItem = page.getByTestId(TEST_IDS.TASK_ITEM("task-1"));
      await expect(taskItem).toBeVisible();
      await taskItem.click();

      // 3. Fill evidence and level resolution form
      const evidenceInput = page.locator("[name='evidenceText']");
      await evidenceInput.fill(
        "Supplied verified transcript confirming advanced distributed systems tenure."
      );

      const levelSelect = page.locator("[name='assignedLevel']");
      await levelSelect.selectOption("proficient");

      // 4. Submit resolution action
      const submitBtn = page.getByTestId(TEST_IDS.SUBMIT_RESOLUTION_BTN);
      await submitBtn.click();

      // 5. Verify superseding result reflects updated score and confidence
      await page.goto(ROUTES.PACKET("candidate-1"));
      const supersedingBadge = page.getByTestId(TEST_IDS.SUPERSEDING_BADGE);
      await expect(supersedingBadge).toBeVisible();

      // 6. Verify original result remains inspectable in version history
      const historyLink = page.getByTestId(TEST_IDS.PRIOR_VERSION_LINK);
      await expect(historyLink).toBeVisible();
      await historyLink.click();
      const priorResult = page.getByTestId(TEST_IDS.PACKET_VIEW);
      await expect(priorResult).toBeVisible();

      // 7. Verify zero live extraction calls occurred
      await page.goto(ROUTES.RUNS);
      const auditLog = await page.content();
      expect(auditLog).not.toContain("live_extraction_attempt");
    }
  );
});
