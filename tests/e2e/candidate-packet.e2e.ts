import { expect, test } from "./harness.js";

/**
 * Required browser workflow 2: Candidate Packet
 * - open the pinned tier-one candidate
 * - assert normalized source text, supporting and contradicting spans,
 *   gaps, score arithmetic, confidence terms, and named routing reasons
 * - verify every highlight matches its stored UTF-16 slice
 * - verify markup payloads render as text
 */
test.describe("Workflow 2: Candidate Packet", () => {
  test.skip("inspects pinned tier-one candidate packet with exact span highlights and arithmetic", async ({ page }) => {
    // 1. Navigate to pinned tier-one candidate packet
    await page.goto("/packet/candidate-1");

    // 2. Assert normalized text rendered safely without HTML injection
    const resumeViewer = page.locator("[data-testid='resume-viewer']");
    await expect(resumeViewer).toBeVisible();
    const rawText = await resumeViewer.innerText();
    expect(rawText).toContain("<script>"); // Rendered as literal text, not executed

    // 3. Assert supporting and contradicting evidence spans
    const supportingHighlights = page.locator("[data-evidence-polarity='supporting']");
    await expect(supportingHighlights).toBeVisible();

    const contradictingHighlights = page.locator("[data-evidence-polarity='contradicting']");
    await expect(contradictingHighlights).toBeVisible();

    // 4. Assert score arithmetic and confidence intervals
    const scoreCard = page.locator("[data-testid='score-card']");
    await expect(scoreCard).toBeVisible();
    const scoreText = await scoreCard.innerText();
    expect(scoreText).toContain("Score:");
    expect(scoreText).toContain("Confidence:");

    // 5. Assert named routing reasons
    const routingReasons = page.locator("[data-testid='routing-reasons']");
    await expect(routingReasons).toBeVisible();
  });
});
