import { test, expect } from "@playwright/test";
import path from "node:path";
import { readFile } from "node:fs/promises";

test("themes persist and contacts and labels remain readable in every projection", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "Рассчитать", exact: true }).click();
  await expect(page.locator(".availability > strong")).toContainText("96,67");
  await page.getByRole("checkbox", { name: "Все связи", exact: true }).check();
  await page.getByRole("checkbox", { name: "ID", exact: true }).check();
  await expect(
    page.getByText("Потяните, чтобы повернуть", { exact: true }),
  ).toHaveCount(0);
  for (const theme of ["light", "dark"]) {
    if (theme === "dark")
      await page
        .getByRole("button", { name: "Тёмная тема", exact: true })
        .click();
    for (const view of ["Глобус", "Карта", "Топология"]) {
      await page.getByRole("button", { name: view, exact: true }).click();
      const style = await page.locator(".network-panel").evaluate((panel) => {
        const label = getComputedStyle(panel.querySelector(".node-label")!);
        const link = getComputedStyle(
          panel.querySelector(".contact-edge:not(.route-edge) .edge-color")!,
        );
        return {
          fill: label.fill,
          stroke: label.stroke,
          width: parseFloat(link.strokeWidth),
          opacity: parseFloat(link.strokeOpacity),
          outline: !!panel.querySelector(".edge-outline"),
        };
      });
      expect(style.fill).toBe("rgb(241, 247, 241)");
      expect(style.stroke).not.toBe("none");
      expect(style.width).toBeGreaterThanOrEqual(1.3);
      expect(style.opacity).toBeGreaterThanOrEqual(0.8);
      expect(style.outline).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: `test-results/${theme}-${view}.png`,
        fullPage: true,
      });
    }
  }
  await page.getByRole("button", { name: "Глобус", exact: true }).click();
  const svg = page.getByLabel("Глобус: земные координаты сети", {
    exact: true,
  });
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height * 0.4, {
    steps: 8,
  });
  await page.mouse.up();
  expect(await page.evaluate(() => getSelection()?.toString())).toBe("");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".availability > strong")).toContainText("96,67");
  await page
    .getByRole("button", { name: "Параметры сценария", exact: true })
    .click();
  await page.screenshot({ path: "test-results/dark-parameters.png" });
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Проектирование", exact: true })
    .click();
  await page.screenshot({
    path: "test-results/dark-editor.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Исследование", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("checkbox", { name: "Все связи", exact: true }).check();
  await page.getByRole("checkbox", { name: "ID", exact: true }).check();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/dark-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Светлая тема", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Автоподбор", exact: true }).click();
  await page.getByLabel("Новых вариантов, до", { exact: true }).fill("24");
  await page
    .getByRole("button", { name: "Подобрать варианты", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Остановить подбор", exact: true })
    .click();
  await expect(
    page.getByText("Подбор отменён. Итоговый набор не сформирован.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("seeded search survives reload, exports evidence and opens a candidate", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Рассчитать", exact: true }),
  ).toBeEnabled();
  await page
    .getByLabel("Загрузить JSON-сценарий", { exact: true })
    .setInputFiles(
      path.resolve(
        import.meta.dirname,
        "../../tests/fixtures/jury-example.json",
      ),
    );
  await page.getByRole("button", { name: "Рассчитать", exact: true }).click();
  await expect(page.locator(".availability > strong")).toContainText("66,67");
  await page.getByRole("button", { name: "Автоподбор", exact: true }).click();
  await page.getByLabel("Новых вариантов, до", { exact: true }).fill("4");
  await page.getByLabel("Номер поиска (seed)", { exact: true }).fill("77");
  await page
    .getByRole("button", { name: "Подобрать варианты", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Компромиссы сети", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("checkbox", { name: "Только Парето и база", exact: true })
    .uncheck();
  await expect(page.locator(".search-table tbody tr")).toHaveCount(3);
  await page
    .getByRole("button", { name: "Выбрать Вариант 1", exact: true })
    .click();
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Скачать поиск", exact: true })
    .click();
  const report = JSON.parse(
    await readFile((await (await downloaded).path())!, "utf8"),
  );
  expect(report.kind).toBe("optimization");
  expect(report.search.options.seed).toBe(77);
  expect(report.cases).toHaveLength(3);
  expect(report.cases[1].scenario.gateway_outages).toEqual(
    report.effective_scenario.gateway_outages,
  );
  await page.screenshot({
    path: "test-results/search-light.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Тёмная тема", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/search-dark.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/search-mobile.png",
    fullPage: true,
  });
  await page.reload();
  await expect(page.locator(".availability > strong")).toContainText("66,67");
  await page.getByRole("button", { name: "Автоподбор", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Компромиссы сети", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Номер поиска (seed)", { exact: true }),
  ).toHaveValue("77");
  await page
    .getByRole("button", { name: "Выбрать Вариант 1", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Открыть выбранный вариант", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Условия и состав сети", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Дальность ISL, км", { exact: true }),
  ).toHaveValue(String(report.cases[1].scenario.environment.isl_range_km));
});
