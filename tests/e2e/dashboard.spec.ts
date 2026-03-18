import { expect, test } from "@playwright/test";

test("renders the dashboard and carries edited inputs across tabs", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Guide the move with scenarios, cashflow, and conversion strategy",
    }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: /USD\/EUR/ })).toBeVisible();

  await page.getByRole("button", { name: "inputs" }).click();
  await page.getByRole("spinbutton", { name: "Close month" }).fill("3");
  await page.getByRole("button", { name: "overview" }).click();

  const selectedCloseMonth = page.getByRole("combobox", { name: "Expected close month" });
  await expect(selectedCloseMonth).toHaveValue("3");

  await page.getByRole("button", { name: "Downside" }).click();
  await expect(page.getByText("Selected strategy in the downside case scenario.")).toBeVisible();

  await page.getByRole("button", { name: "assumptions" }).click();
  await expect(page.getByRole("heading", { name: "Planning aid only" })).toBeVisible();

  expect(consoleErrors).toEqual([]);
});
