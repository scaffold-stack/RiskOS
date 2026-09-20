import { expect, test } from "@playwright/test";

const DEMO_ADDRESS = "SP000000000000000000002Q6VF78";
async function installTestWallet(page: import("@playwright/test").Page) {
  await page.addInitScript(
    ({ address }) => {
      window.__RISKOS_TEST_WALLET__ = {
        async connect() {
          return { address, publicKey: "fixture", label: "E2E wallet" };
        },
        async signMessage(_message: string, challengeId: string) {
          return { publicKey: "fixture", signature: `fixture:${challengeId}` };
        },
        async callContract() {
          return { txid: `0x${"ab".repeat(32)}` };
        },
      };
    },
    { address: DEMO_ADDRESS },
  );
}

test("user can inspect risk and prepare a safe testnet action", async ({ page }) => {
  await installTestWallet(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Know the capital/ })).toBeVisible();
  await page.getByRole("button", { name: "Inspect a portfolio" }).click();
  await expect(page.getByRole("heading", { name: "Inspect a Stacks portfolio" })).toBeVisible();
  await expect(page.getByLabel("Portfolio address")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Connect wallet and analyze" })).toBeVisible();
  await page.getByLabel("Portfolio address").fill(DEMO_ADDRESS);
  await page.getByRole("button", { name: "Analyze address" }).click();
  await expect(page.getByText("Portfolio value")).toBeVisible();
  await expect(page.locator(".Toastify__toast--success")).toContainText("Portfolio analysis updated");
  await expect(page.getByText("Risk posture")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Zest positions" })).toBeVisible();
  await page.getByRole("button", { name: "Risk", exact: true }).click();
  await expect(page.getByText("Lending health factor is 1.0666")).toBeVisible();
  await expect(page.getByText("Estimated exit slippage exceeds 1%")).toBeVisible();
  await expect(page.getByText("What this means:")).toBeVisible();
  await page.getByRole("button", { name: "Protect", exact: true }).click();
  await page.getByRole("button", { name: "Run preflight" }).click();
  await expect(page.getByRole("heading", { name: "Preflight passed" })).toBeVisible();
  await expect(page.getByText(/testnet ·/)).toBeVisible();
  await expect(page.getByText(/TESTNET FIXTURE ONLY/)).toBeVisible();
  await page.getByRole("button", { name: "Connect wallet and continue" }).click();
  await expect(page.getByText("Transaction confirmed")).toBeVisible();
  await expect(
    page.locator(".Toastify__toast--success").filter({ hasText: "Transaction submitted" }),
  ).toBeVisible();
  await expect(page.getByText(`0x${"ab".repeat(32)}`)).toBeVisible();
});

test("wallet owner can create evidence-backed alert rules", async ({ page }) => {
  await installTestWallet(page);
  await page.goto("/#overview");
  await page.getByLabel("Portfolio address").fill(DEMO_ADDRESS);
  await page.getByRole("button", { name: "Analyze address" }).click();
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: /^Alerts/ }).click();
  await expect(page.getByRole("heading", { name: "Alerts" })).toBeVisible();
  const createdRule = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith("/v1/alerts/rules"),
  );
  await page.getByRole("button", { name: "Create alert rule" }).click();
  const createdRuleResponse = await createdRule;
  expect(
    createdRuleResponse.status(),
    await createdRuleResponse.text(),
  ).toBe(201);
  await expect(page.getByText("2 evidence-backed")).toBeVisible();
  await expect(page.getByText("Lending health factor is 1.0666")).toBeVisible();
});

test("user can start analysis from the centered wallet choice", async ({ page }) => {
  await installTestWallet(page);
  await page.goto("/#overview");
  await page.getByRole("button", { name: "Connect wallet and analyze" }).click();
  await expect(page.getByText("Portfolio value")).toBeVisible();
  await expect(page.locator(".Toastify__toast--success")).toContainText(
    "Wallet connected and portfolio loaded",
  );
  await expect(page.getByRole("button", { name: "Wallet connected" })).toBeVisible();
  await expect(page.getByLabel("Stacks address")).toHaveValue(DEMO_ADDRESS);
});

test("invalid addresses fail visibly", async ({ page }) => {
  await page.goto("/#overview");
  await page.getByLabel("Portfolio address").fill("invalid");
  await page.getByRole("button", { name: "Analyze address" }).click();
  await expect(page.getByRole("alert")).toContainText("invalid Stacks address");
  await expect(page.locator(".Toastify__toast--error")).toContainText("invalid Stacks address");
});

test("analyzed public address and data restore after navigation and reload", async ({ page }) => {
  await page.goto("/#overview");
  await page.getByLabel("Portfolio address").fill(DEMO_ADDRESS);
  await page.getByRole("button", { name: "Analyze address" }).click();
  await expect(page.getByText("Portfolio value")).toBeVisible();

  await page.getByRole("button", { name: "Risk", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Risk monitor" })).toBeVisible();
  await expect(page.getByLabel("Stacks address")).toHaveValue(DEMO_ADDRESS);

  await page.reload();
  await expect(page.getByText("Lending health factor is 1.0666")).toBeVisible();
  await expect(page.getByLabel("Stacks address")).toHaveValue(DEMO_ADDRESS);
  await expect(page).toHaveURL(/#risk$/);
});

test("risk monitor centers an explicit empty state when no findings exist", async ({ page }) => {
  await page.goto("/#overview");
  await page.getByLabel("Portfolio address").fill("SP000000000000000000002Q6VF79");
  await page.getByRole("button", { name: "Analyze address" }).click();
  await page.getByRole("button", { name: "Risk", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No current risk findings" })).toBeVisible();
  await expect(page.locator(".page-state-stage")).toBeVisible();
});

test("risk monitor explains metrics in Easy mode and persists Advanced mode", async ({ page }) => {
  await page.goto("/#overview");
  await page.getByLabel("Portfolio address").fill(DEMO_ADDRESS);
  await page.getByRole("button", { name: "Analyze address" }).click();
  await page.getByRole("button", { name: "Risk", exact: true }).click();

  await expect(page.getByRole("button", { name: "Easy" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "How to interpret this number" })).toBeVisible();
  await expect(page.getByText("1.0 is the liquidation boundary.")).toBeVisible();
  await expect(page.locator(".risk-health-reading b")).toHaveText("Very small safety buffer");

  await page.getByRole("button", { name: "Advanced" }).click();
  await expect(page.getByText("Composite risk")).toBeVisible();
  await expect(page.getByText("LTV", { exact: true })).toBeVisible();
  await expect(page.getByText("Model versions and evidence")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Advanced" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Model versions and evidence")).toBeVisible();
});

test("yield strategy engine discovers markets and chooses the split for the user", async ({ page }) => {
  await page.route("**/v1/yield/allocations", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.goto("/#overview");
  await page.getByRole("button", { name: "Protect", exact: true }).click();
  await page.getByRole("button", { name: "Explore earning strategies" }).click();

  await expect(page.getByRole("heading", { name: "Explore yield strategies" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Simulated yield split" })).toBeVisible();
  await expect(page.getByText("Building an evidence-labeled simulation…")).toBeVisible();
  await expect(page.getByText("$600,000.00")).toBeVisible();
  await expect(page.getByText("$400,000.00")).toBeVisible();
  await expect(page.getByText("$73,000.00")).toBeVisible();
  await expect(page.getByText(/Independent comparison: 6\.25%/)).toBeVisible();
  await expect(page.getByText(/maximum at 2% of reported TVL/).first()).toBeVisible();
  await expect(page.getByText(/The split is optimized automatically/)).toBeVisible();
});

test("mobile navigation preserves the core dashboard routes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#overview");
  await page.getByLabel("Portfolio address").fill(DEMO_ADDRESS);
  await page.getByLabel("Portfolio address").press("Enter");
  await page.getByRole("navigation", { name: "Mobile" }).getByRole("button", { name: "Positions" }).click();
  await expect(page.getByRole("heading", { name: "Positions", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Unified positions (4)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open position" })).toHaveCount(0);
  await expect
    .poll(async () =>
      page
        .locator("img.asset-icon-image, img.protocol-icon-image")
        .evaluateAll(
          (images) =>
            images.length > 0 &&
            images.every(
              (image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
            ),
        ),
    )
    .toBe(true);
});
