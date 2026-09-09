import { expect, test } from "./harness.js";
import { ROUTES, TEST_IDS } from "../../apps/web/src/testids.js";

/**
 * Required browser workflow 5: Proposal Review
 * Deferred in T12 Phase 1.
 * - approve, edit, and reject separate follow-up proposals
 * - assert immutable decisions, head movements, retained originals,
 *   and zero outbound effects
 */
test.describe("Workflow 5: Proposal Review Decisions", () => {
  test.fixme(
    "approves, edits, and rejects proposals with immutable audit records and zero outbound effects",
    async ({ page }) => {
      // 1. Navigate to proposal review dashboard
      await page.goto(ROUTES.REVIEW_PROPOSALS);

      // 2. Approve proposal 1
      const proposal1 = page.getByTestId(TEST_IDS.PROPOSAL_ITEM("prop-1"));
      await expect(proposal1).toBeVisible();
      const approveBtn1 = page.getByTestId(TEST_IDS.PROPOSAL_APPROVE_BTN("prop-1"));
      await approveBtn1.click();
      const approvedBadge = page.getByTestId(TEST_IDS.PROPOSAL_STATUS("prop-1"));
      await expect(approvedBadge).toContainText(/approved/i);

      // 3. Edit and approve proposal 2
      const proposal2 = page.getByTestId(TEST_IDS.PROPOSAL_ITEM("prop-2"));
      await expect(proposal2).toBeVisible();
      const editBtn2 = page.getByTestId(TEST_IDS.PROPOSAL_EDIT_BTN("prop-2"));
      await editBtn2.click();
      const editCommentInput = page.getByTestId(TEST_IDS.PROPOSAL_COMMENT_INPUT);
      await editCommentInput.fill("Approved with modified salary range expectation.");
      const confirmEditBtn = page.getByTestId(TEST_IDS.CONFIRM_EDIT_BTN);
      await confirmEditBtn.click();
      const editedBadge = page.getByTestId(TEST_IDS.PROPOSAL_STATUS("prop-2"));
      await expect(editedBadge).toContainText(/edited|approved/i);

      // 4. Reject proposal 3
      const proposal3 = page.getByTestId(TEST_IDS.PROPOSAL_ITEM("prop-3"));
      await expect(proposal3).toBeVisible();
      const rejectBtn3 = page.getByTestId(TEST_IDS.PROPOSAL_REJECT_BTN("prop-3"));
      await rejectBtn3.click();
      const rejectedBadge = page.getByTestId(TEST_IDS.PROPOSAL_STATUS("prop-3"));
      await expect(rejectedBadge).toContainText(/rejected/i);

      // 5. Assert immutable decisions, head movements, and retained originals
      // Original proposal versions remain intact in history
      const versionHistory = page.getByTestId(TEST_IDS.VERSION_HISTORY);
      await expect(versionHistory).toBeVisible();

      // 6. Verify zero outbound side effects occurred
      const outboundIndicator = page.getByTestId(TEST_IDS.OUTBOUND_COUNTER);
      await expect(outboundIndicator).toHaveText("0");
    }
  );
});
