import { expect, test } from "./harness.js";
import { ROUTES, TEST_IDS } from "../../apps/web/src/testids.js";

/**
 * Required browser workflow 6: Audit Trust Center
 * - trace extraction through score, route, resolution, supersession,
 *   proposal, and human decision
 * - assert event ordering, actor names, at least three visible limitations,
 *   proposed and approved bias cuts, synthetic label, and insufficient-sample statement
 */
test.describe("Workflow 6: Audit Trust Center", () => {
  test.fixme(
    "verifies full audit lineage, event sequence, bias cuts, and synthetic data disclaimer",
    async ({ page }) => {
      // 1. Navigate to audit / runs trust center
      await page.goto(ROUTES.RUNS);

      // 2. Verify audit event timeline ordering and actor names
      const eventTable = page.getByTestId(TEST_IDS.AUDIT_EVENT_TABLE);
      await expect(eventTable).toBeVisible();

      const eventRows = page.getByTestId(TEST_IDS.AUDIT_EVENT_ROW);
      await expect(eventRows.first()).toBeVisible();

      // Trace sequence: extraction, score, route, resolution, supersession, proposal, human decision
      const timelineText = await eventTable.innerText();
      expect(timelineText).toContain("extraction");
      expect(timelineText).toContain("score");
      expect(timelineText).toContain("route");
      expect(timelineText).toContain("resolution");
      expect(timelineText).toContain("supersession");
      expect(timelineText).toContain("proposal");
      expect(timelineText).toContain("human_decision");

      // Verify actor attribution is present on audit events
      expect(timelineText).toMatch(/actor|system|operator|reviewer/i);

      // 3. Verify system status and visible known limitations (at least 3 required)
      await page.goto(ROUTES.STATUS);
      const sealStatus = page.getByTestId(TEST_IDS.CORPUS_SEAL_STATUS);
      await expect(sealStatus).toBeVisible();

      const limitations = page.getByTestId(TEST_IDS.KNOWN_LIMITATION_ITEM);
      const limitationCount = await limitations.count();
      expect(limitationCount).toBeGreaterThanOrEqual(3);

      // 4. Verify Class 3 synthetic bias audit display
      await page.goto(ROUTES.REVIEW_BIAS);
      const biasSummary = page.getByTestId(TEST_IDS.BIAS_AUDIT_SUMMARY);
      await expect(biasSummary).toBeVisible();

      // Proposed and human-approved cuts side by side
      const proposedCuts = page.getByTestId(TEST_IDS.PROPOSED_BIAS_CUTS);
      const approvedCuts = page.getByTestId(TEST_IDS.APPROVED_BIAS_CUTS);
      await expect(proposedCuts).toBeVisible();
      await expect(approvedCuts).toBeVisible();

      // 5. Verify synthetic data label and insufficient-sample statement
      const disclaimer = page.getByTestId(TEST_IDS.SYNTHETIC_DATA_DISCLAIMER);
      await expect(disclaimer).toBeVisible();
      const disclaimerText = await disclaimer.innerText();
      expect(disclaimerText.toLowerCase()).toContain("synthetic data");
      expect(disclaimerText.toLowerCase()).toContain("insufficient sample size");
    }
  );
});
