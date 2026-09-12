import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  FileJson,
  History,
  Info,
  LoaderCircle,
  Orbit,
  Play,
  Radio,
  Satellite,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  X,
  AlertTriangle,
  Target,
  Route as RouteIcon,
  Moon,
  Sun,
  Sparkles,
} from "lucide-react";
import { ApiError, download, post, request } from "./api";
import {
  duration,
  number,
  percent,
  reasonColor,
  reasonText,
  time,
} from "./format";
import NetworkView from "./NetworkView";
import Timeline from "./Timeline";
import ScenarioEditor from "./ScenarioEditor";
import ComparisonView from "./ComparisonView";
import ResilienceView from "./ResilienceView";
import OptimizationView from "./OptimizationView";
import SnapshotDetails from "./SnapshotDetails";
import { useAnalysisTool } from "./webmcp";
import type { Run, RunResult, Scenario, Snapshot } from "./types";

type CatalogItem = { file: string; title: string; scenario: Scenario };
const statusText: Record<Run["status"], string> = {
  queued: "В очереди",
  running: "Расчёт",
  cancelling: "Отмена",
  cancelled: "Отменён",
  completed: "Завершён",
  interrupted: "Прерван",
  failed: "Ошибка",
};

export default function App() {
  const [dark, setDark] = useState(
    () => document.documentElement.dataset.theme === "dark",
  );
  useEffect(() => {
    const theme = dark ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", dark ? "#202c32" : "#eeeee4");
    try {
      localStorage.setItem("orbita:theme", theme);
    } catch {}
  }, [dark]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [mode, setMode] = useState<
    "research" | "design" | "compare" | "resilience" | "optimize"
  >("research");
  const [parentRevision, setParentRevision] = useState<string | null>(null);
  const [editorScenario, setEditorScenario] = useState<Scenario | null>(null);
  const [draft, setDraft] = useState<Scenario | null>(null);
  const [catalogFile, setCatalogFile] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [client, setClient] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [history, setHistory] = useState<Run[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [tab, setTab] = useState<"network" | "outages">("network");
  const fileInput = useRef<HTMLInputElement>(null);
  const cache = useRef(new Map<string, Snapshot>());
  const dialogRef = useRef<HTMLDialogElement>(null);

  useAnalysisTool(run, result, client, index);

  const fail = (value: unknown) =>
    setError(
      value instanceof ApiError
        ? value
        : new ApiError(
            value instanceof Error ? value.message : "Неизвестная ошибка",
          ),
    );

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        // Establish the session before parallel requests can set competing cookies.
        await request("/health");
        const [items, runs] = await Promise.all([
          request<CatalogItem[]>("/catalog"),
          request<Run[]>("/runs"),
        ]);
        if (disposed) return;
        setCatalog(items);
        setHistory(runs);
        if (items[0]) {
          setDraft(items[0].scenario);
          setCatalogFile(items[0].file);
          setClient(
            items[0].scenario.ground_sites.find((g) => g.role === "client")
              ?.id ?? "",
          );
        }
        const saved = localStorage.getItem("orbita:last-run");
        if (saved && runs.some((r) => r.id === saved)) setRunId(saved);
      } catch (e) {
        if (!disposed) fail(e);
      } finally {
        if (!disposed) setInitializing(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setRun(null);
    setResult(null);
    setSnapshot(null);
    setIndex(0);
    setPlaying(false);
    localStorage.setItem("orbita:last-run", runId);
    const tick = async () => {
      try {
        const next = await request<Run>(`/runs/${runId}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setRun(next);
        if (next.effective_scenario) {
          setDraft(next.effective_scenario);
          setCatalogFile(
            catalog.find(
              (item) =>
                JSON.stringify(item.scenario) ===
                JSON.stringify(next.effective_scenario),
            )?.file ?? "",
          );
          setClient((c) =>
            next.effective_scenario!.ground_sites.some(
              (g) => g.id === c && g.role === "client",
            )
              ? c
              : next.effective_scenario!.ground_sites.find(
                  (g) => g.role === "client",
                )!.id,
          );
        }
        if (next.status === "completed") {
          const data = await request<RunResult>(`/runs/${runId}/result`, {
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          setResult(data);
          setHistory(
            await request<Run[]>("/runs", { signal: controller.signal }),
          );
        } else if (["queued", "running", "cancelling"].includes(next.status))
          timer = setTimeout(tick, 450);
        else if (next.error) fail(new ApiError(next.error));
      } catch (e) {
        if (!controller.signal.aborted) fail(e);
      }
    };
    tick();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [runId, catalog]);

  useEffect(() => {
    if (!result || !runId) return;
    const key = `${runId}:${index}`;
    const cached = cache.current.get(key);
    if (cached) {
      setSnapshot(cached);
      setSnapshotBusy(false);
      return;
    }
    const controller = new AbortController();
    setSnapshot(null);
    setSnapshotBusy(true);
    request<Snapshot>(`/runs/${runId}/snapshot/${index}`, {
      signal: controller.signal,
    })
      .then((data) => {
        if (controller.signal.aborted) return;
        cache.current.set(key, data);
        if (cache.current.size > 120)
          cache.current.delete(cache.current.keys().next().value!);
        setSnapshot(data);
        setSnapshotBusy(false);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          fail(e);
          setSnapshotBusy(false);
          setPlaying(false);
        }
      });
    return () => controller.abort();
  }, [runId, result, index]);

  useEffect(() => {
    if (!playing || !result) return;
    const timer = setInterval(
      () =>
        setIndex((i) => {
          if (i >= result.summary.sample_count - 1) {
            setPlaying(false);
            return i;
          }
          return i + 1;
        }),
      650,
    );
    return () => clearInterval(timer);
  }, [playing, result]);

  useEffect(() => {
    if (detailsOpen) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [detailsOpen]);

  const selectScenario = (scenario: Scenario, file = "") => {
    setParentRevision(null);
    setRunId(null);
    setRun(null);
    setResult(null);
    setSnapshot(null);
    setDraft(scenario);
    setCatalogFile(file);
    setClient(scenario.ground_sites.find((g) => g.role === "client")!.id);
    setSelected(null);
    setIndex(0);
    setPlaying(false);
    setError(null);
    localStorage.removeItem("orbita:last-run");
  };
  const startRun = async () => {
    if (!draft) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await request<Run>("/runs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(parentRevision
            ? { "X-Orbita-Parent-Revision": parentRevision }
            : {}),
        },
        body: JSON.stringify(draft),
      });
      setRunId(created.id);
      setHistory((h) => [created, ...h]);
    } catch (e) {
      fail(e);
    } finally {
      setSubmitting(false);
    }
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      if (file.size > 10 * 1024 * 1024)
        throw new ApiError("Файл превышает 10 МБ");
      const validated = await request<{ scenario: Scenario }>("/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await file.text(),
      });
      selectScenario(validated.scenario);
    } catch (e) {
      fail(e);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };
  const openHistory = async () => {
    try {
      setHistory(await request<Run[]>("/runs"));
      setHistoryOpen(!historyOpen);
    } catch (e) {
      fail(e);
    }
  };
  const selectNode = (id: string) => {
    setSelected(id);
    if (draft?.ground_sites.some((g) => g.id === id && g.role === "client"))
      setClient(id);
  };

  const scenario = result?.effective_scenario ?? draft;
  const editVariant = (value: Scenario, parent: string) => {
    setEditorScenario(structuredClone(value));
    setParentRevision(parent);
    setMode("design");
  };
  const createFailure = (id: string) => {
    if (!scenario || !run) return;
    const next = structuredClone(scenario);
    next.meta.title += ` · отказ ${id}`;
    next.failures.push({
      satellite_id: id,
      start_s: index * scenario.environment.step_s,
      end_s: scenario.environment.horizon_s,
    });
    editVariant(next, run.revision_id);
  };
  const running =
    submitting ||
    (!!run && ["queued", "running", "cancelling"].includes(run.status));
  const sample = result?.series[client]?.[index];
  const metric = result?.summary.clients[client];
  const ground = scenario?.ground_sites.find((g) => g.id === client);
  const selectedSat = snapshot?.satellites.find((s) => s.id === selected);
  const selectedGround = snapshot?.ground_sites.find((g) => g.id === selected);
  const snapshotRow = snapshot?.clients[client];
  const maxOutage = metric?.outages.reduce(
    (best, o) => (o.duration_s > (best?.duration_s ?? 0) ? o : best),
    metric.outages[0],
  );

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="/" aria-label="Орбита — главная">
          <span className="brand-mark">
            <Orbit size={29} strokeWidth={1.5} />
          </span>
          <span>Орбита</span>
        </a>
        <div className="header-actions">
          <button
            className="theme-toggle"
            onClick={() => setDark(!dark)}
            aria-label={dark ? "Светлая тема" : "Тёмная тема"}
            title={dark ? "Светлая тема" : "Тёмная тема"}
          >
            {dark ? <Sun size={19} /> : <Moon size={19} />}
          </button>
          <button
            className={`quiet ${historyOpen ? "active" : ""}`}
            onClick={openHistory}
          >
            <History size={17} />
            <span>Расчёты</span>
            <span className="count-badge">{history.length}</span>
          </button>
        </div>
      </header>

      <main>
        <div className="workspace-heading">
          <div>
            <h1>
              {
                {
                  research: "Спутниковая сеть",
                  design: "Проектирование",
                  compare: "Сравнение вариантов",
                  resilience: "Устойчивость сети",
                  optimize: "Автоподбор вариантов",
                }[mode]
              }
            </h1>
          </div>
        </div>

        <nav className="workspace-modes" aria-label="Режим работы">
          {(
            [
              ["research", "Исследование"],
              ["design", "Проектирование"],
              ["compare", "Сравнение A/B"],
              ["resilience", "Устойчивость"],
              ["optimize", "Автоподбор"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              aria-pressed={mode === key}
              className={mode === key ? "active" : ""}
              onClick={() => {
                setPlaying(false);
                if (key === "design") {
                  setEditorScenario(
                    scenario ? structuredClone(scenario) : null,
                  );
                  setParentRevision(run?.revision_id ?? parentRevision);
                }
                setMode(key);
              }}
            >
              {key === "research" ? (
                <Orbit size={19} />
              ) : key === "design" ? (
                <SlidersHorizontal size={19} />
              ) : key === "compare" ? (
                <RouteIcon size={19} />
              ) : key === "optimize" ? (
                <Sparkles size={19} />
              ) : (
                <ShieldCheck size={19} />
              )}
              <span>{label}</span>
            </button>
          ))}
        </nav>
        {editorScenario && (
          <div hidden={mode !== "design"}>
            <ScenarioEditor
              key={JSON.stringify(editorScenario)}
              scenario={editorScenario}
              parentId={parentRevision}
              onApply={(value, id) => {
                selectScenario(value);
                setParentRevision(id);
                setMode("research");
              }}
            />
          </div>
        )}
        {mode === "compare" && (
          <ComparisonView
            runs={history}
            currentId={runId}
            onVariant={editVariant}
          />
        )}
        {mode === "resilience" && (
          <ResilienceView run={run} result={result} onVariant={editVariant} />
        )}
        {mode === "optimize" && (
          <OptimizationView
            key={run?.id ?? "empty"}
            run={run}
            result={result}
            onVariant={editVariant}
          />
        )}
        <div hidden={mode !== "research"}>
          <section
            className="scenario-bar"
            aria-label="Выбор и запуск сценария"
          >
            <div className="scenario-select">
              <span className="scenario-icon">
                <Satellite size={21} />
              </span>
              <div>
                <label htmlFor="scenario">Сценарий группировки</label>
                <div className="select-wrap">
                  <select
                    id="scenario"
                    aria-label="Сценарий группировки"
                    value={catalogFile}
                    disabled={initializing || uploading}
                    onChange={(e) => {
                      const item = catalog.find(
                        (x) => x.file === e.target.value,
                      );
                      if (item) {
                        selectScenario(item.scenario, item.file);
                        setParentRevision(null);
                      }
                    }}
                  >
                    {!catalogFile && (
                      <option value="">
                        {draft?.meta.title ?? "Загрузка сценариев…"}
                      </option>
                    )}
                    {catalog.map((item) => (
                      <option key={item.file} value={item.file}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={15} />
                </div>
              </div>
            </div>
            <div className="scenario-facts">
              <span>
                <strong>{scenario?.design.satellites.length ?? "—"}</strong>{" "}
                аппаратов
              </span>
              <span>
                <strong>{scenario?.design.planes.length ?? "—"}</strong>{" "}
                плоскости
              </span>
              <span>
                Очередь{" "}
                <strong>{scenario?.design.launch_stage ?? "—"} / 3</strong>
              </span>
              <button
                className="icon-button"
                aria-label="Параметры сценария"
                disabled={!scenario}
                onClick={() => setDetailsOpen(true)}
              >
                <SlidersHorizontal size={17} />
              </button>
            </div>
            <div className="scenario-actions">
              <input
                ref={fileInput}
                type="file"
                accept=".json,application/json"
                className="visually-hidden"
                aria-label="Загрузить JSON-сценарий"
                onChange={(e) => upload(e.target.files?.[0])}
              />
              <button
                className="secondary"
                disabled={uploading}
                onClick={() => fileInput.current?.click()}
              >
                {uploading ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <Upload size={16} />
                )}
                Загрузить JSON
              </button>
              <button
                className="primary"
                onClick={startRun}
                disabled={!draft || running || uploading}
              >
                {running ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Play size={15} fill="currentColor" />
                )}
                {running
                  ? "Вычисляем…"
                  : result
                    ? "Повторить расчёт"
                    : "Рассчитать"}
              </button>
            </div>
          </section>

          {error && (
            <section className="error-panel" role="alert">
              <AlertTriangle size={20} />
              <div>
                <strong>
                  {error.issues.length
                    ? "Проверьте данные сценария"
                    : error.message}
                </strong>
                {error.issues.length > 0 && (
                  <ul>
                    {error.issues.slice(0, 30).map((issue, i) => (
                      <li key={i}>
                        <code>{issue.path}</code> — {issue.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <button
                className="icon-button"
                aria-label="Закрыть сообщение"
                onClick={() => setError(null)}
              >
                <X size={18} />
              </button>
            </section>
          )}

          {historyOpen && (
            <section className="history-panel">
              <div className="section-title">
                <h2>Сохранённые расчёты</h2>
                <button
                  className="icon-button"
                  aria-label="Закрыть расчёты"
                  onClick={() => setHistoryOpen(false)}
                >
                  <X size={18} />
                </button>
              </div>
              {history.length ? (
                <div className="history-list">
                  {history.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => {
                        setError(null);
                        setCatalogFile("");
                        setRunId(item.id);
                        setHistoryOpen(false);
                      }}
                      className={item.id === runId ? "selected" : ""}
                    >
                      <div>
                        <strong>{item.title}</strong>
                        <span>
                          {new Date(item.created_at).toLocaleString("ru-RU")}
                        </span>
                      </div>
                      <span
                        className={
                          item.status === "completed" ? "text-green" : "muted"
                        }
                      >
                        {statusText[item.status]}
                      </span>
                      <ArrowRight size={16} />
                    </button>
                  ))}
                </div>
              ) : (
                <p className="muted">
                  Завершённые расчёты появятся здесь. Их параметры и результаты
                  сохраняются автоматически.
                </p>
              )}
            </section>
          )}

          {running && run && (
            <div className="job-progress" role="status">
              <LoaderCircle size={17} className="spin" />
              <span>
                {run.status === "queued"
                  ? "Подготавливаем расчёт"
                  : `Рассчитано ${run.progress} из ${run.total} состояний`}
              </span>
              <progress max={run.total} value={run.progress} />
              <button
                className="quiet"
                disabled={run.status === "cancelling"}
                onClick={async () => {
                  try {
                    setRun(await post<Run>(`/runs/${run.id}/cancel`));
                  } catch (e) {
                    fail(e);
                  }
                }}
              >
                {run.status === "cancelling" ? "Отменяем…" : "Отменить"}
              </button>
            </div>
          )}
          {run &&
            !running &&
            ["cancelled", "interrupted", "failed"].includes(run.status) && (
              <div className="notice">
                <Info size={17} />
                Расчёт {statusText[run.status].toLowerCase()}. Можно запустить
                его повторно.
              </div>
            )}

          {scenario && (
            <>
              <div className="metrics-row">
                <div className="metric-card client-metric">
                  <span className="metric-label">
                    <Target size={15} />
                    Клиентский пункт
                  </span>
                  <select
                    aria-label="Клиентский пункт"
                    value={client}
                    onChange={(e) => {
                      setClient(e.target.value);
                      setSelected(e.target.value);
                    }}
                  >
                    {scenario.ground_sites
                      .filter((g) => g.role === "client")
                      .map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.id}
                        </option>
                      ))}
                  </select>
                  <span className="metric-note">
                    {ground ? `${ground.lat_deg}° · ${ground.lon_deg}°` : "—"}
                  </span>
                </div>
                <div className="metric-card">
                  <span className="metric-label">
                    <Radio size={15} />
                    Покрытие
                  </span>
                  <strong>
                    {metric ? percent(metric.coverage) : "—"}
                    <small>{metric ? "%" : ""}</small>
                  </strong>
                  <span className="metric-note">Есть видимый спутник</span>
                  <span className="metric-gauge" aria-hidden="true">
                    <i style={{ width: `${(metric?.coverage ?? 0) * 100}%` }} />
                  </span>
                </div>
                <div
                  className={`metric-card availability ${metric?.target_met ? "achieved" : ""}`}
                >
                  <span className="metric-label">
                    <RouteIcon size={15} />
                    Доступность связи
                  </span>
                  <strong>
                    {metric ? percent(metric.availability) : "—"}
                    <small>{metric ? "%" : ""}</small>
                  </strong>
                  <span className="metric-note">
                    {metric ? (
                      <>
                        <span
                          className={
                            metric.target_met ? "text-green" : "text-amber"
                          }
                        >
                          {metric.target_met ? "Цель достигнута" : "Ниже цели"}
                        </span>{" "}
                        ·{" "}
                      </>
                    ) : (
                      ""
                    )}
                    Цель{" "}
                    {number(scenario.environment.target_availability * 100, 2)}%
                  </span>
                  <span className="metric-gauge" aria-hidden="true">
                    <i
                      style={{ width: `${(metric?.availability ?? 0) * 100}%` }}
                    />
                  </span>
                </div>
                <button
                  className="metric-card outage-metric"
                  disabled={!maxOutage}
                  onClick={() => {
                    if (maxOutage) {
                      setIndex(maxOutage.start_s / scenario.environment.step_s);
                      setTab("outages");
                      setPlaying(false);
                    }
                  }}
                >
                  <span className="metric-label">
                    <Clock3 size={15} />
                    Максимальный перерыв
                  </span>
                  <strong>
                    {metric ? duration(metric.max_outage_s) : "—"}
                  </strong>
                  <span className="metric-note">
                    {metric
                      ? `${metric.outage_count} перерывов за период`
                      : "Результат после расчёта"}
                    {maxOutage && <ArrowRight size={14} />}
                  </span>
                </button>
              </div>

              <section className="workbench">
                <div className="workbench-bar">
                  <div className="workbench-tabs">
                    <button
                      className={tab === "network" ? "selected" : ""}
                      onClick={() => setTab("network")}
                    >
                      <Orbit size={17} />
                      Сеть и маршрут
                    </button>
                    <button
                      className={tab === "outages" ? "selected" : ""}
                      onClick={() => setTab("outages")}
                      disabled={!result}
                    >
                      <Activity size={17} />
                      Перерывы{metric && <span>{metric.outage_count}</span>}
                    </button>
                  </div>
                  <div className="current-time">
                    <span>
                      {snapshotBusy ? "Обновляем состояние" : "Время от начала"}
                    </span>
                    <strong>{time(index * scenario.environment.step_s)}</strong>
                    {snapshotBusy && (
                      <LoaderCircle size={13} className="spin" />
                    )}
                  </div>
                </div>
                <div className="workbench-body">
                  <div className="primary-surface">
                    {tab === "network" ? (
                      <NetworkView
                        scenario={scenario}
                        snapshot={snapshot}
                        client={client}
                        selected={selected}
                        onSelect={selectNode}
                        busy={snapshotBusy}
                      />
                    ) : (
                      <section className="outages-view">
                        <div className="outages-heading">
                          <div>
                            <span className="eyebrow">
                              {client} · ПЕРИОД{" "}
                              {duration(scenario.environment.horizon_s)}
                            </span>
                            <h2>Интервалы без маршрута</h2>
                          </div>
                          <span className="muted">
                            Всего {duration(metric?.total_outage_s ?? 0)}
                          </span>
                        </div>
                        {metric?.outages.length ? (
                          <div className="outages-table-wrap">
                            <table>
                              <thead>
                                <tr>
                                  <th>Начало</th>
                                  <th>Конец</th>
                                  <th>Длительность</th>
                                  <th>Причина</th>
                                  <th />
                                </tr>
                              </thead>
                              <tbody>
                                {metric.outages.map((o) => (
                                  <tr
                                    key={o.start_s}
                                    className={
                                      index * scenario.environment.step_s >=
                                        o.start_s &&
                                      index * scenario.environment.step_s <
                                        o.end_s
                                        ? "current"
                                        : ""
                                    }
                                  >
                                    <td>{time(o.start_s)}</td>
                                    <td>{time(o.end_s)}</td>
                                    <td>{duration(o.duration_s)}</td>
                                    <td>
                                      {Object.keys(o.reason_samples)
                                        .map(
                                          (r) =>
                                            reasonText[
                                              r as keyof typeof reasonText
                                            ],
                                        )
                                        .join(" · ")}
                                    </td>
                                    <td>
                                      <button
                                        className="icon-button"
                                        aria-label={`Показать перерыв ${time(o.start_s)}`}
                                        onClick={() => {
                                          setIndex(
                                            o.start_s /
                                              scenario.environment.step_s,
                                          );
                                          setTab("network");
                                          setPlaying(false);
                                        }}
                                      >
                                        <ArrowRight size={16} />
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <div className="empty-state">
                            <Check size={28} />
                            <h3>Связь без перерывов</h3>
                            <p>На каждом отсчёте существует путь до шлюза.</p>
                          </div>
                        )}
                      </section>
                    )}
                  </div>
                  <aside className="inspector" aria-label="Инспектор маршрута">
                    <div className="inspector-heading">
                      <span className="eyebrow">Маршрут</span>
                      <strong>
                        {client || "Клиент"}
                        <ArrowRight size={16} />
                        {sample?.gateway_id ?? "Шлюз"}
                      </strong>
                    </div>
                    {sample ? (
                      <>
                        <div
                          className="route-status"
                          style={
                            {
                              "--state-color": reasonColor[sample.reason],
                            } as React.CSSProperties
                          }
                        >
                          {sample.path.length ? (
                            <Check size={17} />
                          ) : (
                            <AlertTriangle size={17} />
                          )}
                          <span>{reasonText[sample.reason]}</span>
                        </div>
                        <div className="route-numbers">
                          <div>
                            <strong>{sample.hop_count ?? "—"}</strong>
                            <span>переходов</span>
                          </div>
                          <div>
                            <strong>
                              {sample.distance_km !== null
                                ? number(sample.distance_km)
                                : "—"}
                            </strong>
                            <span>км · длина пути</span>
                          </div>
                        </div>
                        {sample.path.length > 0 ? (
                          <div
                            className="route-chain"
                            aria-label="Последовательность узлов маршрута"
                          >
                            {sample.path.map((id, i) => (
                              <div className="route-chain-item" key={id}>
                                <span
                                  className={`route-node-symbol ${i === 0 || i === sample.path.length - 1 ? "ground" : ""}`}
                                />
                                <button
                                  onClick={() => selectNode(id)}
                                  className={id === selected ? "selected" : ""}
                                >
                                  {id}
                                  <small>
                                    {i === 0
                                      ? "Клиентский пункт"
                                      : i === sample.path.length - 1
                                        ? "Наземный шлюз"
                                        : scenario.design.satellites.find(
                                            (s) => s.id === id,
                                          )?.plane_id}
                                  </small>
                                </button>
                                {i < sample.path.length - 1 && (
                                  <span className="edge-distance">
                                    {snapshot
                                      ? number(
                                          snapshot.edges.find(
                                            ([a, b]) =>
                                              (a === id &&
                                                b === sample.path[i + 1]) ||
                                              (b === id &&
                                                a === sample.path[i + 1]),
                                          )?.[2] ?? 0,
                                        )
                                      : "…"}{" "}
                                    км
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="diagnosis">
                            <p>
                              {sample.reason === "no_client_coverage"
                                ? "Из пункта не виден ни один активный аппарат выше порога возвышения."
                                : sample.reason === "all_gateways_offline"
                                  ? "Клиент видит спутники, но все наземные шлюзы находятся в периодах недоступности."
                                  : sample.reason === "no_gateway_contact"
                                    ? "Клиент видит спутники. Доступные шлюзы сейчас не имеют контакта со спутниковой сетью."
                                    : "Клиент и доступные шлюзы имеют контакты, но их спутниковые компоненты не соединены."}
                            </p>
                            {snapshotRow?.facts && (
                              <dl>
                                <dt>Компоненты клиента</dt>
                                <dd>
                                  {snapshotRow.facts.client_component_ids
                                    .map((i) => i + 1)
                                    .join(", ") || "—"}
                                </dd>
                                <dt>Компоненты шлюзов</dt>
                                <dd>
                                  {snapshotRow.facts.gateway_component_ids
                                    .map((i) => i + 1)
                                    .join(", ") || "—"}
                                </dd>
                              </dl>
                            )}
                          </div>
                        )}
                        <div className="inspector-section">
                          <span className="eyebrow">
                            ВИДИМЫЕ АППАРАТЫ ·{" "}
                            {sample.visible_satellite_ids.length}
                          </span>
                          <div className="chips">
                            {sample.visible_satellite_ids.length ? (
                              sample.visible_satellite_ids.map((id) => (
                                <button
                                  key={id}
                                  onClick={() => selectNode(id)}
                                  className={selected === id ? "selected" : ""}
                                >
                                  {id}
                                  {snapshot && (
                                    <small>
                                      {number(
                                        snapshot.elevation_deg[client]?.[id] ??
                                          0,
                                        1,
                                      )}
                                      °
                                    </small>
                                  )}
                                </button>
                              ))
                            ) : (
                              <span className="muted">
                                Нет контактов с клиентом
                              </span>
                            )}
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="inspector-empty">
                        <RouteIcon size={30} />
                        <h3>От клиента до шлюза</h3>
                        <p>
                          После расчёта здесь появятся маршрут, расстояния и
                          причины перерывов.
                        </p>
                      </div>
                    )}
                    {(selectedSat || selectedGround) && (
                      <div className="object-card">
                        <div>
                          <strong>{selected}</strong>
                          <button
                            className="icon-button"
                            aria-label="Снять выбор объекта"
                            onClick={() => setSelected(null)}
                          >
                            <X size={14} />
                          </button>
                        </div>
                        {selectedSat ? (
                          <>
                            <span>
                              {selectedSat.plane_id} · очередь{" "}
                              {selectedSat.launch_batch}
                            </span>
                            <p
                              className={
                                selectedSat.active ? "text-green" : "text-amber"
                              }
                            >
                              {selectedSat.state === "active"
                                ? "Аппарат активен"
                                : selectedSat.state === "failed"
                                  ? "Аппарат недоступен по отказу"
                                  : "Аппарат ещё не запущен"}
                            </p>
                            <small>
                              Координаты, км: {number(selectedSat.x_km, 1)} /{" "}
                              {number(selectedSat.y_km, 1)} /{" "}
                              {number(selectedSat.z_km, 1)}
                            </small>
                          </>
                        ) : (
                          <>
                            <span>{selectedGround!.name}</span>
                            <p>
                              {selectedGround!.lat_deg}° ·{" "}
                              {selectedGround!.lon_deg}°
                            </p>
                            <small>
                              {selectedGround!.online
                                ? "Доступен"
                                : "Шлюз отключён"}
                            </small>
                          </>
                        )}
                      </div>
                    )}
                    <div className="inspector-footnote">
                      <Info size={14} />
                      <span>
                        Минимум переходов, затем длина пути. Наземные пункты не
                        ретранслируют трафик.
                      </span>
                    </div>
                  </aside>
                </div>
                <div className="network-stats">
                  <span>
                    <Satellite size={14} />
                    <strong>
                      {snapshot?.network.active_satellites ?? "—"}
                    </strong>{" "}
                    активных
                  </span>
                  <span>
                    <Activity size={14} />
                    <strong>{snapshot?.network.isl_edges ?? "—"}</strong>{" "}
                    ISL-контактов
                  </span>
                  <span>
                    <Radio size={14} />
                    <strong>
                      {snapshot?.network.component_count ?? "—"}
                    </strong>{" "}
                    компонент сети
                  </span>
                  <span className="model-note">
                    {scenario.environment.altitude_km} км ·{" "}
                    {scenario.environment.min_elevation_deg}° min · ISL{" "}
                    {number(scenario.environment.isl_range_km)} км
                  </span>
                </div>
              </section>

              {result && (
                <Timeline
                  result={result}
                  scenario={scenario}
                  index={index}
                  client={client}
                  playing={playing}
                  onIndex={(i) => {
                    setIndex(i);
                    setPlaying(false);
                  }}
                  onClient={setClient}
                  onPlaying={setPlaying}
                />
              )}
              {!result && (
                <div className="before-run-note">
                  <Clock3 size={18} />
                  <span>
                    <strong>
                      {scenario.environment.horizon_s /
                        scenario.environment.step_s}{" "}
                      расчётных отсчётов
                    </strong>{" "}
                    за {duration(scenario.environment.horizon_s)}. Timeline
                    появится после моделирования.
                  </span>
                </div>
              )}
              {result && (
                <SnapshotDetails
                  snapshot={snapshot}
                  client={client}
                  scenario={scenario}
                  onFailure={createFailure}
                />
              )}
              <footer className="result-footer">
                <div>
                  <span>{result ? "Сохранить результаты" : ""}</span>
                </div>
                <div>
                  <button
                    className="quiet"
                    disabled={!runId}
                    onClick={() => download(`/runs/${runId}/scenario`)}
                  >
                    <FileJson size={16} />
                    Сценарий
                  </button>
                  <button
                    className="secondary"
                    disabled={!result}
                    onClick={() => download(`/runs/${runId}/export`)}
                  >
                    <ArrowDownToLine size={16} />
                    Выгрузить результат
                  </button>
                </div>
              </footer>
            </>
          )}
          {initializing && (
            <div className="empty-state">
              <LoaderCircle className="spin" size={26} />
              <p>Загружаем рабочую область…</p>
            </div>
          )}
        </div>
      </main>

      <dialog
        ref={dialogRef}
        onCancel={() => setDetailsOpen(false)}
        onClick={(e) => {
          if (e.target === dialogRef.current) setDetailsOpen(false);
        }}
        className="parameters-dialog"
      >
        <div className="dialog-heading">
          <div>
            <span className="eyebrow">Параметры</span>
            <h2>{scenario?.meta.title}</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Закрыть параметры"
            onClick={() => setDetailsOpen(false)}
          >
            <X size={20} />
          </button>
        </div>
        {scenario && (
          <>
            <dl className="parameter-grid">
              <div>
                <dt>Высота орбиты</dt>
                <dd>{scenario.environment.altitude_km} км</dd>
              </div>
              <div>
                <dt>Наклонение</dt>
                <dd>{scenario.environment.inclination_deg}°</dd>
              </div>
              <div>
                <dt>Дальность ISL</dt>
                <dd>{number(scenario.environment.isl_range_km)} км</dd>
              </div>
              <div>
                <dt>Угол возвышения</dt>
                <dd>≥ {scenario.environment.min_elevation_deg}°</dd>
              </div>
              <div>
                <dt>Период расчёта</dt>
                <dd>{duration(scenario.environment.horizon_s)}</dd>
              </div>
              <div>
                <dt>Шаг сетки</dt>
                <dd>{scenario.environment.step_s} с</dd>
              </div>
              <div>
                <dt>Начальный угол Земли</dt>
                <dd>{scenario.environment.earth_angle0_deg}°</dd>
              </div>
              <div>
                <dt>Целевая доступность</dt>
                <dd>{scenario.environment.target_availability * 100}%</dd>
              </div>
            </dl>
            <h3>Орбитальные плоскости</h3>
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>RAAN</th>
                  <th>Фаза</th>
                  <th>Аппаратов</th>
                </tr>
              </thead>
              <tbody>
                {scenario.design.planes.map((p) => (
                  <tr key={p.id}>
                    <td>{p.id}</td>
                    <td>{p.raan_deg}°</td>
                    <td>{p.phase_deg}°</td>
                    <td>
                      {
                        scenario.design.satellites.filter(
                          (s) => s.plane_id === p.id,
                        ).length
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h3>Периоды недоступности</h3>
            <div className="event-list">
              {[
                ...scenario.failures.map((o) => ({ id: o.satellite_id, ...o })),
                ...scenario.gateway_outages.map((o) => ({
                  id: o.gateway_id,
                  ...o,
                })),
              ].map((o, i) => (
                <div key={i}>
                  <strong>{o.id}</strong>
                  <span>
                    [{time(o.start_s)}; {time(o.end_s)})
                  </span>
                </div>
              ))}
              {!scenario.failures.length &&
                !scenario.gateway_outages.length && (
                  <p className="muted">Заданных отказов нет.</p>
                )}
            </div>
            <p className="dialog-note">
              Загруженный сценарий сохраняется целиком. Параметры этого расчёта
              неизменяемы; другой JSON создаёт отдельный вариант.
            </p>
          </>
        )}
      </dialog>
    </div>
  );
}
