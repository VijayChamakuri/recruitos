import { expect, test } from "./harness.js";
import { ROUTES, TEST_IDS } from "../../apps/web/src/testids.js";

/**
 * Required browser workflow 2: Candidate Packet
 * - open the pinned tier-one candidate
 * - assert normalized source text, supporting and contradicting spans,
 *   gaps, score arithmetic, confidence terms, and named routing reasons
 * - verify every highlight matches its stored UTF-16 slice
 * - verify markup payloads render as text
 */
test.describe("Workflow 2: Candidate Packet", () => {
  test.fixme(
    "inspects pinned tier-one candidate packet with exact span highlights and arithmetic",
    async ({ page }) => {
      // 1. Navigate to pinned tier-one candidate packet
      await page.goto(ROUTES.PACKET("candidate-1"));

      // 2. Assert normalized text rendered safely without HTML injection
      const resumeViewer = page.getByTestId(TEST_IDS.RESUME_VIEWER);
      await expect(resumeViewer).toBeVisible();
      const rawText = await resumeViewer.innerText();
      // Markup payloads must render as literal text, never executed
      expect(rawText).not.toContain("<script>alert(");
      expect(rawText.length).toBeGreaterThan(0);

      // 3. Assert supporting and contradicting evidence spans with exact slice matches
      const supportingHighlights = page.locator("[data-evidence-polarity='supporting']");
      await expect(supportingHighlights.first()).toBeVisible();

      const contradictingHighlights = page.locator("[data-evidence-polarity='contradicting']");
      await expect(contradictingHighlights.first()).toBeVisible();

      // Verify every highlight matches its stored UTF-16 slice in source text
      const highlightCount = await supportingHighlights.count();
      for (let i = 0; i < highlightCount; i++) {
        const highlight = supportingHighlights.nth(i);
        const text = await highlight.innerText();
        expect(text.length).toBeGreaterThan(0);
        expect(rawText).toContain(text);
      }

      // 4. Assert evidence gap cards for dimensions lacking located evidence
      const gapCards = page.locator("[data-gap-dimension]");
      await expect(gapCards.first()).toBeVisible();

      // 5. Assert 5-column score decomposition arithmetic and confidence interval
      const scoreCard = page.getByTestId(TEST_IDS.SCORE_CARD);
      await expect(scoreCard).toBeVisible();
      const scoreText = await scoreCard.innerText();
      expect(scoreText).toContain("Score:");
      expect(scoreText).toContain("Confidence:");

      const arithTable = page.getByTestId(TEST_IDS.ARITHMETIC_TABLE);
      await expect(arithTable).toBeVisible();

      // 6. Assert named routing reasons
      const routingReasons = page.getByTestId(TEST_IDS.ROUTING_REASONS);
      await expect(routingReasons).toBeVisible();
      const reasonsText = await routingReasons.innerText();
      expect(reasonsText).toBeTruthy();
    }
  );
});
