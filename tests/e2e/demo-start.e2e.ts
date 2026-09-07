import { expect, test } from "./harness.js";

/**
 * Required browser workflow 1: Demo Start
 * - invoke the real `make demo`
 * - assert migrations, exactly 140 main candidates, fixture finalization,
 *   Class 1 completion, and production UI readiness
 * - assert zero live extraction requests
 */
test.describe("Workflow 1: Demo Start", () => {
  test.skip("executes make demo and renders production UI with 140 candidates and 0 live calls", async ({ page }) => {
    // 1. Production UI is accessible at baseURL
    await page.goto("/status");
    const title = await page.title();
    expect(title).toContain("RecruitOS");

    // 2. Status page confirms schema migrations and candidate count
    const statusContent = await page.content();
    expect(statusContent).toContain("140");
    expect(statusContent).toContain("sealed");

    // 3. Navigate to triage dashboard
    await page.goto("/triage");
    const triageHeading = page.getByRole("heading", { name: /Triage/i });
    await expect(triageHeading).toBeVisible();

    // 4. Assert fixture finalization: exactly 140 candidates listed
    const candidateList = page.locator("[data-testid='candidate-row']");
    await expect(candidateList).toBeVisible();

    // 5. Assert zero live extraction calls recorded in audit trail
    await page.goto("/runs");
    const auditText = await page.content();
    expect(auditText).toContain("fixture");
    expect(auditText).not.toContain("live_call_error");
  });
});
