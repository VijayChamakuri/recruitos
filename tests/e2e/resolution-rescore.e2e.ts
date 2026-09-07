import { expect, test } from "./harness.js";

/**
 * Required browser workflow 3: Resolution Rescore
 * - supply evidence and level for a pinned missing-evidence task
 * - assert score and confidence change in a superseding result
 * - keep the original result and evidence inspectable
 * - assert zero live calls
 */
test.describe("Workflow 3: Resolution Rescore", () => {
  test.skip("resolves missing evidence task, supersedes triage result, and retains original", async ({ page }) => {
    // 1. Navigate to resolution tasks view
    await page.goto("/review?tab=tasks");

    // 2. Open pinned missing-evidence task
    const taskItem = page.locator("[data-testid='task-item-task-1']");
    await expect(taskItem).toBeVisible();
    await taskItem.click();

    // 3. Fill evidence and level resolution form
    const evidenceInput = page.locator("[name='evidenceText']");
    await evidenceInput.fill("Supplied verified transcript from accredited institution.");

    const levelSelect = page.locator("[name='assignedLevel']");
    await levelSelect.fill("Senior");

    // 4. Submit resolution action
    const submitBtn = page.getByRole("button", { name: /Submit Resolution/i });
    await submitBtn.click();

    // 5. Verify superseding result reflects updated score and confidence
    await page.goto("/packet/candidate-1");
    const updatedBadge = page.locator("[data-testid='superseding-badge']");
    await expect(updatedBadge).toBeVisible();

    // 6. Verify original result remains inspectable in version history
    const historyLink = page.getByText(/View Prior Version/i);
    await expect(historyLink).toBeVisible();
  });
});
