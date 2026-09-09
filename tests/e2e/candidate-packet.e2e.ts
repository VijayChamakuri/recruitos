import { expect, test } from "./harness.js";
import { ROUTES, TEST_IDS } from "../../apps/web/src/testids.js";

const ROUTE_1_SOURCE_KEY = "demo/route-1-scored";
const ROUTE_4_SOURCE_KEY = "demo/route-4-reviewable-failure";

/**
 * Required browser workflow 2: Candidate Packet
 * Opens route 1 (scored) and route 4 (escalated / assessment_unavailable)
 * from the seven-candidate proving corpus.
 */
test.describe("Workflow 2: Candidate Packet", () => {
  test("opens route 1 and route 4 packets from the queue and rejects unknown ids", async ({
    page
  }) => {
    await page.goto(`${ROUTES.TRIAGE}?theme=light&density=default`);
    await expect(page.getByTestId(TEST_IDS.TRIAGE_QUEUE)).toBeVisible();
    await expect(page.getByTestId(TEST_IDS.SYNTHETIC_DATA_PILL).first()).toHaveText(
      "SYNTHETIC DATA"
    );

    const route1Link = page.getByRole("link", { name: ROUTE_1_SOURCE_KEY });
    await expect(route1Link).toBeVisible();
    await route1Link.click();

    await expect(page.getByTestId(TEST_IDS.PACKET_VIEW)).toBeVisible();
    await expect(page.getByTestId(TEST_IDS.PACKET_INSPECTING_LABEL)).toHaveText(
      "Inspecting: current head"
    );
    await expect(page.getByTestId(TEST_IDS.SYNTHETIC_DATA_PILL).first()).toHaveText(
      "SYNTHETIC DATA"
    );
    await expect(page.getByTestId(TEST_IDS.SCORE_CARD)).toContainText("467/6");
    await expect(page.getByTestId(TEST_IDS.ARITHMETIC_TABLE)).toBeVisible();
    await expect(page.getByTestId(TEST_IDS.PANE_SOURCE)).toBeVisible();
    await expect(page.getByTestId(TEST_IDS.RESUME_VIEWER)).toBeVisible();
    const header = page.locator("main.work > div").first();
    await expect(header).not.toContainText("/ 100");
    const sourceText = await page.getByTestId(TEST_IDS.RESUME_VIEWER).innerText();
    expect(sourceText).not.toContain("<script>alert(");
    expect(sourceText.length).toBeGreaterThan(0);
    const highlights = page.getByTestId(TEST_IDS.SPAN_HIGHLIGHT);
    await expect(highlights.first()).toBeVisible();

    await page.getByTestId(TEST_IDS.RETURN_TO_QUEUE).click();
    await expect(page.getByTestId(TEST_IDS.TRIAGE_QUEUE)).toBeVisible();
    await expect(page.getByTestId(TEST_IDS.CANDIDATE_ROW)).toHaveCount(7);

    const route4Link = page.getByRole("link", { name: ROUTE_4_SOURCE_KEY });
    await expect(route4Link).toBeVisible();
    await route4Link.click();

    await expect(page.getByTestId(TEST_IDS.PACKET_VIEW)).toBeVisible();
    await expect(page.locator("main")).toContainText("escalated");
    await expect(page.getByTestId(TEST_IDS.ROUTING_REASON_TAG("assessment_unavailable"))).toBeVisible();
    await expect(page.getByTestId(TEST_IDS.PACKET_TASKS)).toContainText("open");
    await expect(page.getByTestId(TEST_IDS.SCORE_CARD)).toContainText("unavailable");

    await page.goto(`${ROUTES.PACKET("does-not-exist")}?theme=light&density=default`);
    await expect(page.getByTestId(TEST_IDS.PACKET_NOT_FOUND)).toBeVisible();
    await expect(page.getByTestId(TEST_IDS.PACKET_NOT_FOUND)).toContainText(
      "Candidate Packet Not Found"
    );
  });
});
