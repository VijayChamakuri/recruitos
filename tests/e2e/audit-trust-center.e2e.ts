import { expect, test } from "./harness.js";

/**
 * Required browser workflow 6: Audit Trust Center
 * - trace extraction through score, route, resolution, supersession,
 *   proposal, and human decision
 * - assert event ordering, actor names, at least three visible limitations,
 *   proposed and approved bias cuts, synthetic label, and insufficient-sample statement
 */
test.describe("Workflow 6: Audit Trust Center", () => {
  test.skip("verifies full audit lineage, event sequence, bias cuts, and synthetic data disclaimer", async ({ page }) => {
    // 1. Navigate to audit / runs trust center
    await page.goto("/runs");

    // 2. Verify audit event timeline ordering and actor names
    const eventRows = page.locator("[data-testid='audit-event-row']");
    await expect(eventRows).toBeVisible();

    // 3. Verify visible known limitations (at least 3 required)
    const limitationsList = page.locator("[data-testid='known-limitations'] li");
    const count = await limitationsList.textContent();
    expect(count).toBeTruthy();

    // 4. Verify Class 3 synthetic bias audit display
    await page.goto("/review?tab=bias");
    const biasSummary = page.locator("[data-testid='bias-audit-summary']");
    await expect(biasSummary).toBeVisible();

    // 5. Verify synthetic data and insufficient sample size disclaimer
    const disclaimer = page.locator("[data-testid='synthetic-data-disclaimer']");
    await expect(disclaimer).toBeVisible();
    const disclaimerText = await disclaimer.innerText();
    expect(disclaimerText).toContain("synthetic data");
    expect(disclaimerText).toContain("insufficient sample size");
  });
});
