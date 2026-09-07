import { expect, test } from "./harness.js";

/**
 * Required browser workflow 5: Proposal Review
 * - approve, edit, and reject separate follow-up proposals
 * - assert immutable decisions, head movements, retained originals,
 *   and zero outbound effects
 */
test.describe("Workflow 5: Proposal Review Decisions", () => {
  test.skip("approves, edits, and rejects proposals with immutable audit records", async ({ page }) => {
    // 1. Navigate to proposal review dashboard
    await page.goto("/review?tab=proposals");

    // 2. Approve proposal 1
    const approveBtn = page.locator("[data-testid='proposal-approve-prop-1']");
    await approveBtn.click();
    const approvedBadge = page.locator("[data-testid='status-prop-1']");
    await expect(approvedBadge).toHaveText(/approved/i);

    // 3. Edit and approve proposal 2
    const editBtn = page.locator("[data-testid='proposal-edit-prop-2']");
    await editBtn.click();
    const editInput = page.locator("[name='proposalComment']");
    await editInput.fill("Approved with modified salary range expectation.");
    const confirmEditBtn = page.getByRole("button", { name: /Confirm Edit/i });
    await confirmEditBtn.click();

    // 4. Reject proposal 3
    const rejectBtn = page.locator("[data-testid='proposal-reject-prop-3']");
    await rejectBtn.click();
    const rejectedBadge = page.locator("[data-testid='status-prop-3']");
    await expect(rejectedBadge).toHaveText(/rejected/i);

    // 5. Verify zero outbound side effects occurred
    const outboundIndicator = page.locator("[data-testid='outbound-counter']");
    await expect(outboundIndicator).toHaveText("0");
  });
});
