import { expect, test } from "./harness.js";
import { ROUTES, TEST_IDS } from "../../apps/web/src/testids.js";

/**
 * Required browser workflow 6: Audit Trust Center.
 * This slice activates only the persisted audit ledger on /runs.
 * Trust Center cards, bias cuts, and fabricated extraction/score/route
 * categories stay deferred.
 */
test.describe("Workflow 6: Audit Trust Center", () => {
  test("renders persisted audit events and the append-only disclaimer", async ({ page }) => {
    await page.goto(ROUTES.RUNS);

    const eventTable = page.getByTestId(TEST_IDS.AUDIT_EVENT_TABLE);
    await expect(eventTable).toBeVisible();

    const eventRows = page.getByTestId(TEST_IDS.AUDIT_EVENT_ROW);
    await expect(eventRows.first()).toBeVisible();

    const timelineText = await eventTable.innerText();
    expect(timelineText).toContain("candidate.result.published");
    expect(timelineText).toContain("triage_run.sealed");
    expect(timelineText).toContain("Event ID");
    expect(timelineText).toContain("Ordinal");
    expect(timelineText).toContain("Command ID");
    expect(timelineText).toContain("Payload hash");
    expect(timelineText).not.toContain("corpus_sealed");
    expect(timelineText).not.toContain("triage_run_started");

    const disclaimer = page.getByTestId(TEST_IDS.AUDIT_APPEND_ONLY_DISCLAIMER);
    await expect(disclaimer).toBeVisible();
    await expect(disclaimer).toHaveText(
      "Append-only, enforced by database triggers. Not cryptographically tamper-proof. An administrator with file access can replace history."
    );
  });

  test.fixme(
    "verifies full audit lineage, event sequence, bias cuts, and synthetic data disclaimer",
    async ({ page }) => {
      await page.goto(ROUTES.RUNS);

      const eventTable = page.getByTestId(TEST_IDS.AUDIT_EVENT_TABLE);
      await expect(eventTable).toBeVisible();

      const eventRows = page.getByTestId(TEST_IDS.AUDIT_EVENT_ROW);
      await expect(eventRows.first()).toBeVisible();

      const timelineText = await eventTable.innerText();
      expect(timelineText).toContain("extraction");
      expect(timelineText).toContain("score");
      expect(timelineText).toContain("route");
      expect(timelineText).toContain("resolution");
      expect(timelineText).toContain("supersession");
      expect(timelineText).toContain("proposal");
      expect(timelineText).toContain("human_decision");

      expect(timelineText).toMatch(/actor|system|operator|reviewer/i);

      await page.goto(ROUTES.STATUS);
      const sealStatus = page.getByTestId(TEST_IDS.CORPUS_SEAL_STATUS);
      await expect(sealStatus).toBeVisible();

      const limitations = page.getByTestId(TEST_IDS.KNOWN_LIMITATION_ITEM);
      const limitationCount = await limitations.count();
      expect(limitationCount).toBeGreaterThanOrEqual(3);

      await page.goto(ROUTES.REVIEW_BIAS);
      const biasSummary = page.getByTestId(TEST_IDS.BIAS_AUDIT_SUMMARY);
      await expect(biasSummary).toBeVisible();

      const proposedCuts = page.getByTestId(TEST_IDS.PROPOSED_BIAS_CUTS);
      const approvedCuts = page.getByTestId(TEST_IDS.APPROVED_BIAS_CUTS);
      await expect(proposedCuts).toBeVisible();
      await expect(approvedCuts).toBeVisible();

      const disclaimer = page.getByTestId(TEST_IDS.SYNTHETIC_DATA_DISCLAIMER);
      await expect(disclaimer).toBeVisible();
      const disclaimerText = await disclaimer.innerText();
      expect(disclaimerText.toLowerCase()).toContain("synthetic data");
      expect(disclaimerText.toLowerCase()).toContain("insufficient sample size");
    }
  );
});
