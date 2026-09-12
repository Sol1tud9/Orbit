import { useEffect, useState } from "react";
import { request } from "./api";
import { percent, duration, time, number, savedAt } from "./format";
import NetworkView, { defaultViewSettings } from "./NetworkView";
import { saveJson } from "./ScenarioEditor";
import type { Run, RunResult, Comparison, Snapshot, Scenario } from "./types";

export default function ComparisonView({
  runs,
  currentId,
  onVariant,
}: {
  runs: Run[];
  currentId: string | null;
  onVariant: (scenario: Scenario, parentId: string) => void;
}) {
  const completed = runs.filter((r) => r.status === "completed");
  const [a, setA] = useState(
    completed.find((r) => r.id !== currentId)?.id ?? completed[0]?.id ?? "",
  );
  const [b, setB] = useState(
    currentId ?? completed.find((r) => r.id !== a)?.id ?? "",
  );
  const [data, setData] = useState<Comparison | null>(null);
  const [results, setResults] = useState<[RunResult, RunResult] | null>(null);
  const [snaps, setSnaps] = useState<[Snapshot, Snapshot] | null>(null);
  const [index, setIndex] = useState(0);
  const [client, setClient] = useState("");
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [settings, setSettings] = useState(defaultViewSettings);
  useEffect(() => {
    setData(null);
    setResults(null);
    setSnaps(null);
    setIndex(0);
    setPlaying(false);
    setError("");
    if (!a || !b) return;
    const controller = new AbortController();
    Promise.all([
      request<Comparison>(`/compare?a=${a}&b=${b}`, {
        signal: controller.signal,
      }),
      request<RunResult>(`/runs/${a}/result`, { signal: controller.signal }),
      request<RunResult>(`/runs/${b}/result`, { signal: controller.signal }),
    ])
      .then(([d, x, y]) => {
        if (controller.signal.aborted) return;
        setData(d);
        setResults([x, y]);
        setClient(Object.keys(x.series)[0]);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [a, b]);
  useEffect(() => {
    setSnaps(null);
    if (!data?.compatible) return;
    const controller = new AbortController();
    Promise.all([
      request<Snapshot>(`/runs/${a}/snapshot/${index}`, {
        signal: controller.signal,
      }),
      request<Snapshot>(`/runs/${b}/snapshot/${index}`, {
        signal: controller.signal,
      }),
    ])
      .then((s) => {
        if (!controller.signal.aborted) setSnaps(s);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setError(e.message);
          setPlaying(false);
        }
      });
    return () => controller.abort();
  }, [a, b, index, data]);
  useEffect(() => {
    if (!playing || !results) return;
    const timer = setInterval(
      () =>
        setIndex((i) => {
          if (i >= results[0].summary.sample_count - 1) {
            setPlaying(false);
            return i;
          }
          return i + 1;
        }),
      900,
    );
    return () => clearInterval(timer);
  }, [playing, results]);
  const selection = (
    label: string,
    value: string,
    onChange: (v: string) => void,
  ) => (
    <label>
      {label}
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Выберите расчёт</option>
        {completed.map((r) => (
          <option key={r.id} value={r.id}>
            {r.title} · {savedAt(r.created_at)}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section className="product-panel" aria-label="Сравнение конфигураций">
      <div className="panel-intro">
        <div>
          <h2>Что изменилось в сети</h2>
          <p>
            Дельта B − A. Выигрыш и потери считаются по каждому отсчёту и
            каждому клиенту.
          </p>
        </div>
        {data && (
          <button
            className="secondary"
            onClick={() =>
              saveJson("orbita-comparison.json", { a, b, ...data })
            }
          >
            Экспорт сравнения
          </button>
        )}
      </div>
      <div className="comparison-selectors">
        {selection("Базовый расчёт A", a, setA)}
        {selection("Новый расчёт B", b, setB)}
      </div>
      {error && (
        <div role="alert" className="error-panel">
          {error}
        </div>
      )}
      {!data && (
        <p className="empty-note">
          {a && b
            ? "Сопоставляем результаты…"
            : "Для сравнения нужны два завершённых расчёта."}
        </p>
      )}
      {data && !data.compatible && (
        <div className="warning-note">
          <strong>Прямое сравнение недопустимо</strong>
          {data.issues.map((i) => (
            <p key={i}>{i}</p>
          ))}
          {results && data.issues.some((i) => i.includes("_s")) && (
            <button
              className="secondary"
              onClick={() => {
                const s = structuredClone(results[1].effective_scenario);
                s.environment.step_s =
                  results[0].effective_scenario.environment.step_s;
                s.environment.horizon_s =
                  results[0].effective_scenario.environment.horizon_s;
                onVariant(s, completed.find((r) => r.id === b)!.revision_id);
              }}
            >
              Подготовить B на сетке A
            </button>
          )}
        </div>
      )}
      {data?.compatible && results && (
        <>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Клиент</th>
                  <th>A · доступность</th>
                  <th>B · доступность</th>
                  <th>Δ, п.п.</th>
                  <th>Восстановлено</th>
                  <th>Потеряно</th>
                  <th>Макс. перерыв A → B</th>
                </tr>
              </thead>
              <tbody>
                {data.clients.map((c) => (
                  <tr key={c.client_id}>
                    <td>
                      <button
                        className="quiet"
                        onClick={() => setClient(c.client_id)}
                      >
                        {c.client_id}
                      </button>
                    </td>
                    <td>{percent(c.a.availability)}%</td>
                    <td>{percent(c.b.availability)}%</td>
                    <td
                      className={
                        c.availability_delta >= 0 ? "text-green" : "text-red"
                      }
                    >
                      {c.availability_delta > 0 ? "+" : ""}
                      {number(c.availability_delta * 100, 2)}
                    </td>
                    <td>{c.gained_samples}</td>
                    <td>{c.lost_samples}</td>
                    <td>
                      {duration(c.a.max_outage_s)} →{" "}
                      {duration(c.b.max_outage_s)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="comparison-controls">
            <label>
              Клиент сравнения
              <select
                value={client}
                onChange={(e) => setClient(e.target.value)}
              >
                {data.clients.map((c) => (
                  <option key={c.client_id}>{c.client_id}</option>
                ))}
              </select>
            </label>
            <button className="secondary" onClick={() => setPlaying(!playing)}>
              {playing ? "Пауза A/B" : "Воспроизвести A/B"}
            </button>
            <label>
              Общий отсчёт
              <input
                aria-label="Общий отсчёт"
                type="range"
                min="0"
                max={results[0].summary.sample_count - 1}
                value={index}
                onChange={(e) => {
                  setPlaying(false);
                  setIndex(Number(e.target.value));
                }}
              />
            </label>
            <output>
              {time(index * results[0].effective_scenario.environment.step_s)}
            </output>
          </div>
          <div className="delta-track" aria-label="Изменение связи во времени">
            {data.clients
              .find((c) => c.client_id === client)
              ?.transitions.map((state, i) => (
                <button
                  key={i}
                  className={state}
                  title={`${time(i * results[0].effective_scenario.environment.step_s)} · ${state === "gained" ? "Связь восстановлена" : state === "lost" ? "Связь потеряна" : "Без изменения"}`}
                  aria-label={`Перейти к отсчёту ${i + 1}`}
                  onClick={() => setIndex(i)}
                />
              ))}
          </div>
          <div className="delta-legend" aria-label="Легенда сравнения">
            <span>
              <i className="gained" />
              Связь восстановлена
            </span>
            <span>
              <i className="lost" />
              Связь потеряна
            </span>
            <span>
              <i />
              Без изменений
            </span>
          </div>
          <div className="comparison-scenes">
            {results.map((r, i) => (
              <div className="comparison-scene" key={i}>
                <h3>
                  {i === 0 ? "A" : "B"} · {r.effective_scenario.meta.title}
                </h3>
                <NetworkView
                  scenario={r.effective_scenario}
                  snapshot={snaps?.[i] ?? null}
                  client={client}
                  selected={null}
                  onSelect={() => {}}
                  busy={!snaps}
                  settings={settings}
                  onSettings={setSettings}
                />
                <p className="path-text">
                  {r.series[client]?.[index]?.path.join(" → ") ||
                    "Нет сквозного маршрута"}
                </p>
              </div>
            ))}
          </div>
        </>
      )}
      {data && (
        <details className="diff-panel" open={!data.compatible}>
          <summary>Изменения сценария · {data.diff.length}</summary>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Параметр</th>
                  <th>A</th>
                  <th>B</th>
                </tr>
              </thead>
              <tbody>
                {data.diff.map((d, i) => (
                  <tr key={i}>
                    <td>{d.path}</td>
                    <td>{JSON.stringify(d.before)}</td>
                    <td>{JSON.stringify(d.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.diff.length && <p>Сценарии идентичны.</p>}
        </details>
      )}
    </section>
  );
}
