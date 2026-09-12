import { test, expect } from "@playwright/test";
import path from "node:path";
import { globePoint } from "../src/projection";

const fixture = path.resolve(
  import.meta.dirname,
  "../../tests/fixtures/jury-example.json",
);
async function load(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Рассчитать", exact: true }),
  ).toBeEnabled();
  await page
    .getByLabel("Загрузить JSON-сценарий", { exact: true })
    .setInputFiles(fixture);
  await page.getByRole("button", { name: "Рассчитать", exact: true }).click();
  await expect(page.locator(".availability > strong")).toContainText("66,67");
}

test("ECEF projection preserves Earth axes, altitude and occlusion", () => {
  expect(globePoint(6371, 0, 0, 0, 0)).toEqual({
    x: 390,
    y: 258,
    visible: true,
  });
  expect(globePoint(-6371, 0, 0, 0, 0).visible).toBe(false);
  expect(globePoint(0, 6371, 0, 0, 0).x).toBeCloseTo(580);
  expect(globePoint(0, 0, 6371, 0, 0).y).toBeCloseTo(68);
  expect(globePoint(0, 6921, 0, 0, 0).x).toBeCloseTo(390 + (190 * 6921) / 6371);
  expect(globePoint(0, 6371, 0, 90, 0).x).toBeCloseTo(390);
  expect(globePoint(0, 0, 6371, 0, 90).y).toBeCloseTo(258);
  expect(globePoint(-1000, 6921, 0, 0, 0).visible).toBe(true);
});

test("eighteen-hop route, keyboard topology and globe layout", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Сценарий группировки", { exact: true })
    .selectOption("03_satellite_outages.json");
  await page.getByRole("button", { name: "Рассчитать", exact: true }).click();
  await expect(page.locator(".availability > strong")).toContainText("79,31");
  await page
    .getByLabel("Клиентский пункт", { exact: true })
    .selectOption("C70");
  await page.getByLabel("Номер отсчёта", { exact: true }).fill("487");
  await expect(page.locator(".route-chain-item")).toHaveCount(19);
  await page.getByRole("button", { name: "Топология", exact: true }).click();
  await page.getByRole("button", { name: "Спутник S01", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByLabel("Инспектор маршрута", { exact: true }),
  ).toContainText("S01");
  await page.locator(".route-chain-item").last().scrollIntoViewIfNeeded();
  await expect(page.locator(".route-chain-item").last()).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/long-route-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Глобус", exact: true }).click();
  for (const [width, height] of [
    [1440, 900],
    [1280, 720],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const layout = await page.evaluate(() => {
      const footer = document
        .querySelector(".scene-footer")!
        .getBoundingClientRect();
      const controls = document
        .querySelector(".globe-controls")!
        .getBoundingClientRect();
      return { footerTop: footer.top, controlsBottom: controls.bottom };
    });
    expect(layout.footerTop).toBeGreaterThanOrEqual(layout.controlsBottom - 1);
  }
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.querySelector(".inspector")?.scrollTo(0, 0);
  });
  await page.screenshot({
    path: "test-results/globe-mobile.png",
    fullPage: true,
  });
});

test("edit, revision, recompute, comparison and synchronized globe", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await load(page);
  await page
    .getByRole("button", { name: "Проектирование", exact: true })
    .click();
  await page
    .getByLabel("Название", { exact: true })
    .fill("Вариант без отключения");
  await page.getByLabel("Плоскости 1: RAAN, °", { exact: true }).fill("1");
  await page.getByLabel("Плоскости 1: Фаза, °", { exact: true }).fill("1");
  await page
    .getByRole("button", { name: "Удалить: Отключения шлюзов 2", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Сохранить ревизию", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("сохранён");
  await page.screenshot({
    path: "test-results/editor-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Применить к рабочей области", exact: true })
    .click();
  await expect(page.locator(".availability > strong")).toContainText("—");
  await page.getByRole("button", { name: "Рассчитать", exact: true }).click();
  await expect(page.locator(".availability > strong")).toContainText("100,00");
  await page
    .getByRole("button", { name: "Сравнение A/B", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Что изменилось в сети" }),
  ).toBeVisible();
  await expect(page.locator(".comparison-scenes")).toBeVisible();
  await expect(
    page
      .getByLabel("Базовый расчёт A", { exact: true })
      .locator("option:checked"),
  ).toContainText("Два шлюза");
  await expect(
    page
      .getByLabel("Новый расчёт B", { exact: true })
      .locator("option:checked"),
  ).toContainText("Вариант без отключения");
  await expect(
    page
      .getByLabel("Сравнение конфигураций", { exact: true })
      .locator(".data-table")
      .first(),
  ).toContainText("66,67");
  await page
    .getByRole("button", { name: "Глобус", exact: true })
    .first()
    .click();
  const comparison = page.getByLabel("Сравнение конфигураций", { exact: true });
  await expect(
    comparison.getByLabel("Глобус: земные координаты сети", { exact: true }),
  ).toHaveCount(2);
  await comparison
    .getByLabel("Долгота камеры", { exact: true })
    .first()
    .fill("40");
  await expect(
    comparison.getByLabel("Долгота камеры", { exact: true }).last(),
  ).toHaveValue("40");
  await page.getByLabel("Общий отсчёт", { exact: true }).fill("1");
  await expect(page.locator(".comparison-controls output")).toContainText(
    "00:02:00",
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/comparison-desktop.png",
    fullPage: true,
  });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/comparison-mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("reserve route, full N-1, recommendations and applying evidence", async ({
  page,
}) => {
  await load(page);
  await page
    .getByText("Резервный маршрут и проверка причин", { exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Следующий допустимый маршрут" }),
  ).toBeVisible();
  await expect(page.locator(".diagnostic-nodes")).toContainText("Есть обход");
  await page.getByText(/Таблица контактов ·/).click();
  await page.getByLabel("Поиск узла", { exact: true }).fill("Relay-X");
  await expect(page.locator(".contacts-table tbody")).toContainText("Relay-X");
  await page.getByLabel("Масштаб времени", { exact: true }).selectOption("4");
  await page.getByRole("button", { name: "Устойчивость", exact: true }).click();
  await page
    .getByRole("button", { name: "Проверить N−1", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Проверено аппаратов: 2" }),
  ).toBeVisible();
  await expect(page.locator(".product-panel .data-table")).toContainText(
    "66,67",
  );
  await page
    .getByRole("button", { name: "Найти проверенные улучшения", exact: true })
    .click();
  await expect(
    page.getByText("Улучшение подтверждено", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".recommendation").first()).toContainText("100,00");
  await page.screenshot({
    path: "test-results/recommendations-desktop.png",
    fullPage: true,
  });
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", {
      name: "Скачать отчёт с доказательствами",
      exact: true,
    })
    .click();
  expect((await download).suggestedFilename()).toContain("orbita-experiment");
  await page
    .getByRole("button", { name: "Открыть вариант в редакторе", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Условия и состав сети" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Удалить: Отключения шлюзов 1",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("editor invalid values remain editable and experiment cancellation is explicit", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Рассчитать", exact: true }).click();
  await expect(page.locator(".availability > strong")).toContainText("96,67");
  await page.getByRole("button", { name: "Устойчивость", exact: true }).click();
  await page
    .getByRole("button", { name: "Проверить N−1", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Отменить эксперимент", exact: true })
    .click();
  await expect(page.getByText(/Эксперимент отменён/)).toBeVisible();
  await page
    .getByRole("button", { name: "Проектирование", exact: true })
    .click();
  await page.getByLabel("Шаг, с", { exact: true }).fill("0");
  await page
    .getByRole("button", { name: "Применить к рабочей области", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("environment.step_s");
  await expect(page.getByLabel("Шаг, с", { exact: true })).toHaveValue("0");
  await page
    .getByRole("button", { name: "Сбросить правки", exact: true })
    .click();
  await expect(page.getByLabel("Шаг, с", { exact: true })).toHaveValue("120");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/editor-mobile.png",
    fullPage: true,
  });
});
