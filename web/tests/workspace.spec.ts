import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");

test("all four organizer scenarios, timeline, route and export", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  for (const [label, expected] of [
    ["Полная группировка", "96,67"],
    ["Первая очередь запуска", "27,22"],
    ["Недоступность десяти аппаратов", "79,31"],
    ["Дальность межспутниковой связи 2000 км", "77,50"],
  ]) {
    await page
      .getByLabel("Сценарий группировки", { exact: true })
      .selectOption({ label });
    await page.getByRole("button", { name: "Рассчитать", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Повторить расчёт", exact: true }),
    ).toBeEnabled();
    await expect(page.locator(".availability > strong")).toContainText(
      expected,
    );
    await expect(page.getByLabel("Номер отсчёта", { exact: true })).toHaveValue(
      "1",
    );
    if (label === "Полная группировка") {
      await expect(page.locator(".route-status")).toContainText(
        "Маршрут доступен",
      );
      await page.screenshot({
        path: "test-results/full-desktop.png",
        fullPage: true,
      });
    }
  }
  await page
    .getByLabel("Клиентский пункт", { exact: true })
    .selectOption("C70");
  await expect(page.locator(".availability > strong")).toContainText("62,22");
  await page
    .getByRole("button", { name: "Следующий перерыв", exact: true })
    .click();
  await expect(page.locator(".route-status")).toContainText(
    "Разрыв спутниковой сети",
  );
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Выгрузить результат", exact: true })
    .click();
  const file = await download;
  const payload = JSON.parse(await readFile((await file.path())!, "utf8"));
  expect(payload.schema_version).toBe("cosmo-A-result-1.0");
  expect(payload.routes).toHaveLength(2160);
  expect(payload.effective_scenario.environment.isl_range_km).toBe(2000);
  await page.reload();
  await expect(page.locator(".availability > strong")).toContainText("77,50");
  await expect(
    page.getByLabel("Сценарий группировки", { exact: true }),
  ).toHaveValue("04_link_range.json");
  expect(errors).toEqual([]);
});

test("new IDs, two gateways, off-grid outages, saved parameters", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Рассчитать", exact: true }),
  ).toBeEnabled();
  await page
    .getByLabel("Загрузить JSON-сценарий", { exact: true })
    .setInputFiles(path.join(root, "tests/fixtures/jury-example.json"));
  await expect(
    page.getByLabel("Клиентский пункт", { exact: true }),
  ).toHaveValue("Терминал-А");
  await page.getByRole("button", { name: "Рассчитать", exact: true }).click();
  await expect(page.locator(".availability > strong")).toContainText("66,67");
  await page.getByLabel("Номер отсчёта", { exact: true }).fill("2");
  await expect(
    page.getByLabel("Выбранное время", { exact: true }),
  ).toContainText("00:02:00");
  await expect(page.locator(".route-status")).toContainText(
    "Все шлюзы отключены",
  );
  await page.getByLabel("Номер отсчёта", { exact: true }).fill("3");
  await expect(page.locator(".route-status")).toContainText("Маршрут доступен");
});

test("invalid input keeps current scenario, responsive controls remain usable", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Рассчитать", exact: true }),
  ).toBeEnabled();
  await page
    .getByLabel("Загрузить JSON-сценарий", { exact: true })
    .setInputFiles({
      name: "invalid.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"schema_version":"bad"}'),
    });
  await expect(page.getByRole("alert")).toContainText("schema_version");
  await expect(
    page.getByLabel("Сценарий группировки", { exact: true }),
  ).toHaveValue("01_full_constellation.json");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: "Параметры сценария", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
  }
});
