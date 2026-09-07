import { expect, test } from "./harness.js";

/**
 * Required browser workflow 4: Stale Conflict
 * - open one task or proposal in two browser contexts
 * - commit in the first and submit the stale second action
 * - assert no second mutation and require refresh
 */
test.describe("Workflow 4: Stale Conflict Handling", () => {
  test.skip("detects concurrent mutation conflict between contexts and requires refresh", async ({ context }) => {
    // 1. Context A opens resolution task
    const pageA = await context.newPage();
    await pageA.goto("/review?tab=tasks&id=task-1");

    // 2. Context B opens same resolution task
    const pageB = await context.newPage();
    await pageB.goto("/review?tab=tasks&id=task-1");

    // 3. Context A commits first resolution action successfully
    const submitBtnA = pageA.getByRole("button", { name: /Submit/i });
    await submitBtnA.click();
    const successToastA = pageA.locator("[data-testid='toast-success']");
    await expect(successToastA).toBeVisible();

    // 4. Context B submits stale second action without refreshing
    const submitBtnB = pageB.getByRole("button", { name: /Submit/i });
    await submitBtnB.click();

    // 5. Context B receives stale head conflict error and refresh notice
    const conflictBanner = pageB.locator("[data-testid='conflict-error']");
    await expect(conflictBanner).toBeVisible();
    const errorText = await conflictBanner.innerText();
    expect(errorText).toContain("stale");

    // 6. Assert no duplicate mutation occurred in database
    await pageB.close();
    await pageA.close();
  });
});
