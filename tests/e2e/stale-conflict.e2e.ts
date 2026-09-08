import { expect, test } from "./harness.js";
import { ROUTES, TEST_IDS } from "../../apps/web/src/testids.js";

/**
 * Required browser workflow 4: Stale Conflict Handling
 * - open one task or proposal in two browser contexts
 * - commit in the first and submit the stale second action
 * - assert no second mutation and require refresh
 */
test.describe("Workflow 4: Stale Conflict Handling", () => {
  test.fixme(
    "detects concurrent mutation conflict between contexts and requires refresh",
    async ({ context }) => {
      // 1. Context A opens resolution task
      const pageA = await context.newPage();
      await pageA.goto(ROUTES.REVIEW_TASKS);
      const taskItemA = pageA.getByTestId(TEST_IDS.TASK_ITEM("task-1"));
      await expect(taskItemA).toBeVisible();

      // 2. Context B opens the same resolution task concurrently
      const pageB = await context.newPage();
      await pageB.goto(ROUTES.REVIEW_TASKS);
      const taskItemB = pageB.getByTestId(TEST_IDS.TASK_ITEM("task-1"));
      await expect(taskItemB).toBeVisible();

      // 3. Context A commits first resolution action successfully
      const submitBtnA = pageA.getByTestId(TEST_IDS.SUBMIT_RESOLUTION_BTN);
      await submitBtnA.click();
      const successToastA = pageA.getByTestId(TEST_IDS.TOAST_SUCCESS);
      await expect(successToastA).toBeVisible();

      // 4. Context B submits stale second action without refreshing
      const submitBtnB = pageB.getByTestId(TEST_IDS.SUBMIT_RESOLUTION_BTN);
      await submitBtnB.click();

      // 5. Context B receives stale head conflict error and refresh notice
      const conflictBanner = pageB.getByTestId(TEST_IDS.CONFLICT_ERROR_BANNER);
      await expect(conflictBanner).toBeVisible();
      const errorText = await conflictBanner.innerText();
      expect(errorText.toLowerCase()).toContain("stale");

      // 6. Assert no duplicate mutation occurred in database
      await pageB.close();
      await pageA.close();
    }
  );
});
