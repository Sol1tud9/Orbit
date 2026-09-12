import { useEffect, useState } from "react";
import { ArrowUpRight, Download, Sparkles } from "lucide-react";
import { request, post, download } from "./api";
import { duration, number, percent, savedAt } from "./format";
import type { Run, RunResult, Scenario, Comparison } from "./types";

type Options = {
  seed: number;
  budget: number;
  max_isl_range_km: number;
  phase_shift_deg: number;
  include_next_stages: boolean;
};
type Candidate = {
  key: string;
  title: string;
  is_baseline: boolean;
  pareto: boolean;
  supported_improvement: boolean;
  scenario: Scenario;
  summary: RunResult["summary"];
  comparison: Comparison;
  phase_offsets: Record<string, number>;
  objectives: {
    worst_availability: number;
    worst_outage_s: number;
    deployed_satellites: number;
    isl_range_km: number;
  };
};
type Report = {
  cases: Candidate[];
  search: {
    options: Options;
    space_size: string;
    exhaustive: boolean;
    anchor_plane: string | null;
  };
  summary: {
    case_count: number;
    pareto_count: number;
    improvement_count: number;
  };
};

export default function OptimizationView({
  run,
  result,
  onVariant,
}: {
  run: Run | null;
  result: RunResult | null;
  onVariant: (scenario: Scenario, parentId: string) => void;
}) {
  const baseRange = result?.effective_scenario.environment.isl_range_km ?? 3000;
  const [options, setOptions] = useState<Options>({
    seed: 2026,
    budget: 12,
    max_isl_range_km: Math.min(10000, baseRange + 2000),
    phase_shift_deg: 15,
    include_next_stages: true,
  });
  const [jobs, setJobs] = useState<Run[]>([]);
  const [jobId, setJobId] = useState("");
  const [job, setJob] = useState<Run | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [selected, setSelected] = useState("0");
  const [frontierOnly, setFrontierOnly] = useState(true);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [compact, setCompact] = useState(
    () => window.matchMedia("(max-width: 640px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)");
    const changed = () => setCompact(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  const running =
    submitting ||
    (!!job && ["queued", "running", "cancelling"].includes(job.status));
  useEffect(() => {
    const controller = new AbortController();
    request<Run[]>("/experiments", { signal: controller.signal })
      .then((rows) => {
        if (controller.signal.aborted) return;
        const matches = rows.filter(
          (r) => r.kind === "optimization" && r.parent_run_id === run?.id,
        );
        setJobs(matches);
        if (matches[0]) setJobId(matches[0].id);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [run?.id]);
  useEffect(() => {
    setReport(null);
    setJob(null);
    setError("");
    if (!jobId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const current = await request<Run>(`/runs/${jobId}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setJob(current);
        if (current.status === "completed") {
          const value = await request<Report>(`/experiments/${jobId}/report`, {
            signal: controller.signal,
          });
          if (controller.signal.aborted) return;
          setReport(value);
          setOptions(value.search.options);
          setSelected(
            (
              value.cases.find((c) => c.pareto && !c.is_baseline) ??
              value.cases[0]
            ).key,
          );
        } else if (["queued", "running", "cancelling"].includes(current.status))
          timer = setTimeout(tick, 600);
        else if (current.error) setError(current.error);
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      }
    };
    tick();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [jobId]);
  const start = async () => {
    if (!run) return;
    setSubmitting(true);
    setError("");
    try {
      const current = await post<Run>("/experiments", {
        run_id: run.id,
        kind: "optimization",
        options,
      });
      setJob(current);
      setJobs((rows) => [current, ...rows]);
      setJobId(current.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };
  const candidate = report?.cases.find((c) => c.key === selected);
  const visible =
    report?.cases.filter((c) => !frontierOnly || c.pareto || c.is_baseline) ??
    [];
  const ranges = report?.cases.map((c) => c.objectives.isl_range_km) ?? [
    baseRange,
  ];
  const rangeMin = Math.min(...ranges),
    rangeMax = Math.max(...ranges);
  const chartWidth = compact ? 330 : 760;
  const chartLeft = compact ? 42 : 70;
  const chartRight = chartWidth - (compact ? 28 : 50);
  const x = (v: number) =>
    rangeMax === rangeMin
      ? (chartLeft + chartRight) / 2
      : chartLeft +
        ((v - rangeMin) / (rangeMax - rangeMin)) * (chartRight - chartLeft);
  const y = (v: number) => 222 - v * 178;
  return (
    <section
      className="product-panel optimization"
      aria-label="Автоподбор конфигураций"
    >
      <div className="panel-intro">
        <div>
          <h2>Найти баланс параметров</h2>
          <p>
            Сравните сочетания очереди, дальности связи и фаз плоскостей на всей
            временной сетке.
          </p>
        </div>
        <span className="status-pill">Полный пересчёт</span>
      </div>
      {!run || !result ? (
        <p className="empty-note">
          Сначала рассчитайте базовый сценарий в режиме исследования.
        </p>
      ) : (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              start();
            }}
            className="search-form"
          >
            <div className="editor-grid">
              <label>
                Новых вариантов, до
                <input
                  required
                  type="number"
                  min="1"
                  max="24"
                  step="1"
                  value={options.budget}
                  onChange={(e) =>
                    setOptions({ ...options, budget: Number(e.target.value) })
                  }
                />
              </label>
              <label>
                Дальность ISL, до км
                <input
                  required
                  type="number"
                  min={baseRange}
                  max="10000"
                  step="any"
                  value={options.max_isl_range_km}
                  onChange={(e) =>
                    setOptions({
                      ...options,
                      max_isl_range_km: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label>
                Сдвиг фаз ±, °
                <input
                  required
                  type="number"
                  min="0"
                  max="45"
                  step="any"
                  value={options.phase_shift_deg}
                  onChange={(e) =>
                    setOptions({
                      ...options,
                      phase_shift_deg: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label>
                Номер поиска (seed)
                <input
                  required
                  type="number"
                  min="0"
                  max="2147483647"
                  step="1"
                  value={options.seed}
                  onChange={(e) =>
                    setOptions({ ...options, seed: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <div className="search-actions">
              <label className="search-checkbox">
                <input
                  type="checkbox"
                  checked={options.include_next_stages}
                  onChange={(e) =>
                    setOptions({
                      ...options,
                      include_next_stages: e.target.checked,
                    })
                  }
                />
                Разрешить следующие очереди
              </label>
              <button className="primary" disabled={running}>
                <Sparkles size={16} />
                Подобрать варианты
              </button>
            </div>
          </form>
          <p className="muted search-context">
            База: {run.title}. Отказы, клиенты и временная сетка сохраняются.
            Одинаковые настройки и seed воспроизводят набор вариантов.
          </p>
          {!!jobs.length && (
            <label className="search-history">
              Сохранённый поиск
              <select
                disabled={running}
                value={jobId}
                onChange={(e) => setJobId(e.target.value)}
              >
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {savedAt(j.created_at)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
      {error && (
        <div role="alert" className="error-panel">
          {error}
        </div>
      )}
      {running && job && (
        <div className="experiment-progress" role="status">
          <progress max={job.total} value={job.progress} />
          <span>
            {Math.round((job.progress / Math.max(1, job.total)) * 100)}%
          </span>
          <button
            className="secondary"
            disabled={job.status === "cancelling"}
            onClick={async () => {
              try {
                setJob(await post<Run>(`/runs/${job.id}/cancel`));
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Остановить подбор
          </button>
        </div>
      )}
      {job && ["cancelled", "interrupted", "failed"].includes(job.status) && (
        <p className="warning-note">
          {job.status === "cancelled"
            ? "Подбор отменён. Итоговый набор не сформирован."
            : "Подбор не завершён. Запустите его повторно."}
        </p>
      )}
      {report && (
        <>
          <div className="search-summary">
            <div>
              <strong>{report.summary.case_count}</strong>
              <span>новых вариантов проверено</span>
            </div>
            <div>
              <strong>{report.summary.pareto_count}</strong>
              <span>вариантов на границе Парето</span>
            </div>
            <div>
              <strong>{report.summary.improvement_count}</strong>
              <span>улучшений без потерь связи</span>
            </div>
          </div>
          <div className="section-title">
            <h3>Компромиссы сети</h3>
            <button
              className="secondary"
              onClick={() => download(`/experiments/${jobId}/report`)}
            >
              <Download size={15} />
              Скачать поиск
            </button>
          </div>
          <p className="muted">
            На границе Парето нет другого проверенного варианта, который не хуже
            по всем четырём критериям и лучше хотя бы по одному: доступность
            худшего клиента, максимальный перерыв, число развёрнутых аппаратов и
            дальность ISL.
          </p>
          <div className="pareto-chart">
            <svg
              viewBox={`0 0 ${chartWidth} 275`}
              role="group"
              aria-label="Дальность и доступность вариантов"
            >
              <text x={chartLeft} y="21">
                Доступность худшего клиента
              </text>
              {[0, 0.25, 0.5, 0.75, 1].map((v) => (
                <g key={v}>
                  <line x1={chartLeft} x2={chartRight} y1={y(v)} y2={y(v)} />
                  <text x={chartLeft - 10} y={y(v) + 4} textAnchor="end">
                    {v * 100}%
                  </text>
                </g>
              ))}
              {[...new Set(ranges)]
                .sort((a, b) => a - b)
                .map((v) => (
                  <text key={v} x={x(v)} y="247" textAnchor="middle">
                    {number(v)} км
                  </text>
                ))}
              {report.cases.map((c) => (
                <g
                  key={c.key}
                  role="button"
                  tabIndex={0}
                  aria-label={`Выбрать ${c.title}`}
                  onClick={() => setSelected(c.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelected(c.key);
                    }
                  }}
                  className={`pareto-point ${c.pareto ? "frontier" : ""} ${c.is_baseline ? "baseline" : ""} ${c.key === selected ? "selected" : ""}`}
                  transform={`translate(${x(c.objectives.isl_range_km)},${y(c.objectives.worst_availability)})`}
                >
                  <title>
                    {c.title}: {percent(c.objectives.worst_availability)}%,{" "}
                    {c.objectives.deployed_satellites} аппаратов, перерыв{" "}
                    {duration(c.objectives.worst_outage_s)}
                  </title>
                  <circle r="7" />
                </g>
              ))}
            </svg>
            <div className="delta-legend">
              <span>
                <i className="gained" />
                Граница Парето
              </span>
              <span>
                <i className="baseline-dot" />
                Базовый вариант
              </span>
              <span>
                <i />
                Остальные сочетания
              </span>
            </div>
          </div>
          <div className="section-title">
            <label className="search-checkbox">
              <input
                type="checkbox"
                checked={frontierOnly}
                onChange={(e) => setFrontierOnly(e.target.checked)}
              />
              Только Парето и база
            </label>
            <span className="muted">
              Seed {report.search.options.seed} ·{" "}
              {report.search.exhaustive
                ? "Вся заданная сетка сочетаний"
                : `Выборка из ${report.search.space_size} сочетаний`}
            </span>
          </div>
          <div className="table-scroll">
            <table className="data-table search-table">
              <thead>
                <tr>
                  <th>Вариант</th>
                  <th>Доступность, мин.</th>
                  <th>Перерыв, макс.</th>
                  <th>Аппараты</th>
                  <th>ISL, км</th>
                  <th>Цель у всех</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => (
                  <tr
                    key={c.key}
                    className={c.key === selected ? "selected" : ""}
                  >
                    <td>
                      <button
                        className="quiet"
                        aria-pressed={c.key === selected}
                        onClick={() => setSelected(c.key)}
                      >
                        {c.title}
                        {c.pareto ? " · Парето" : ""}
                      </button>
                    </td>
                    <td>{percent(c.objectives.worst_availability)}%</td>
                    <td>{duration(c.objectives.worst_outage_s)}</td>
                    <td>{c.objectives.deployed_satellites}</td>
                    <td>{number(c.objectives.isl_range_km, 2)}</td>
                    <td>
                      {c.summary.all_clients_target_met
                        ? "Достигнута"
                        : "Не достигнута"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {candidate && (
            <article className="search-selection">
              <div className="section-title">
                <h3>{candidate.title}</h3>
                <span className="status-pill">
                  {candidate.is_baseline
                    ? "Исходный сценарий"
                    : candidate.supported_improvement
                      ? "Улучшение без потерь"
                      : "Проверьте компромиссы"}
                </span>
              </div>
              <p className="muted">
                Очередь {candidate.scenario.design.launch_stage} · ISL{" "}
                {number(candidate.objectives.isl_range_km, 2)} км
                {Object.entries(candidate.phase_offsets)
                  .filter(([, v]) => v !== 0)
                  .map(([id, v]) => ` · ${id}: ${v > 0 ? "+" : ""}${v}°`)}
              </p>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Клиент</th>
                      <th>Доступность: база → вариант</th>
                      <th>Восстановлено</th>
                      <th>Потеряно</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidate.comparison.clients.map((c) => (
                      <tr key={c.client_id}>
                        <td>{c.client_id}</td>
                        <td>
                          {percent(c.a.availability)} →{" "}
                          {percent(c.b.availability)}%
                        </td>
                        <td>{c.gained_samples}</td>
                        <td>{c.lost_samples}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button
                className="primary"
                disabled={candidate.is_baseline}
                onClick={() => onVariant(candidate.scenario, run!.revision_id)}
              >
                Открыть выбранный вариант
                <ArrowUpRight size={16} />
              </button>
            </article>
          )}
          <p className="muted search-context">
            Граница построена только по проверенным сочетаниям, включая базу.
            Число аппаратов и дальность — параметры проекта, а не денежная
            стоимость. Фаза опорной плоскости{" "}
            {report.search.anchor_plane ?? "—"} фиксирована. Глобальный оптимум
            не заявляется.
          </p>
        </>
      )}
    </section>
  );
}
