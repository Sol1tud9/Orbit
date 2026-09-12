import { useEffect, useState } from "react";
import { request, post, download } from "./api";
import { percent, duration, number, savedAt } from "./format";
import type {
  Run,
  RunResult,
  Scenario,
  ClientSummary,
  Comparison,
} from "./types";

type Case = {
  satellite_id: string;
  clients: Record<string, ClientSummary>;
  lost_samples: Record<string, number>;
  worst_loss: number;
  total_loss: number;
};
type Candidate = {
  title: string;
  limitation: string;
  scenario: Scenario;
  summary: RunResult["summary"];
  comparison: Comparison;
  supported_improvement: boolean;
  gained_samples: number;
};
type Report = {
  kind: string;
  summary: {
    case_count: number;
    critical_count?: number;
    improvement_count?: number;
  };
  cases: (Case | Candidate)[];
};

export default function ResilienceView({
  run,
  result,
  onVariant,
}: {
  run: Run | null;
  result: RunResult | null;
  onVariant: (scenario: Scenario, parentId: string) => void;
}) {
  const [jobs, setJobs] = useState<Run[]>([]);
  const [jobId, setJobId] = useState("");
  const [job, setJob] = useState<Run | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    setJobId("");
    setJob(null);
    setReport(null);
    setError("");
    let disposed = false;
    request<Run[]>("/experiments")
      .then((rows) => {
        if (disposed) return;
        const matches = rows.filter(
          (r) => r.parent_run_id === run?.id && r.kind !== "optimization",
        );
        setJobs(matches);
        if (matches[0]) setJobId(matches[0].id);
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      });
    return () => {
      disposed = true;
    };
  }, [run?.id]);
  useEffect(() => {
    setReport(null);
    setJob(null);
    if (!jobId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const j = await request<Run>(`/runs/${jobId}`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setJob(j);
        if (j.status === "completed") {
          const r = await request<Report>(`/experiments/${jobId}/report`, {
            signal: controller.signal,
          });
          if (!controller.signal.aborted) setReport(r);
        } else if (["running", "queued", "cancelling"].includes(j.status))
          timer = setTimeout(tick, 600);
        else if (j.error) setError(j.error);
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
  const running =
    submitting ||
    (!!job && ["running", "queued", "cancelling"].includes(job.status));
  const start = async (kind: string) => {
    if (!run) return;
    setSubmitting(true);
    setError("");
    try {
      const j = await post<Run>("/experiments", { run_id: run.id, kind });
      setJobs((rows) => [j, ...rows]);
      setJobId(j.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };
  const applyFailure = (sat: string) => {
    if (!result || !run) return;
    const scenario = structuredClone(result.effective_scenario);
    scenario.meta.title += ` · отказ ${sat}`;
    scenario.failures.push({
      satellite_id: sat,
      start_s: 0,
      end_s: scenario.environment.horizon_s,
    });
    onVariant(scenario, run.revision_id);
  };
  return (
    <section className="product-panel" aria-label="Анализ устойчивости">
      <div className="panel-intro">
        <div>
          <h2>Где сети нужен резерв</h2>
          <p>
            Проверьте отключение каждого аппарата на весь период или сравните
            варианты улучшения связи.
          </p>
        </div>
      </div>
      {!result || !run ? (
        <p className="empty-note">
          Сначала завершите базовый расчёт в рабочей области.
        </p>
      ) : (
        <>
          <div className="experiment-actions">
            <button
              className="primary"
              disabled={running}
              onClick={() => start("n_minus_one")}
            >
              Проверить N−1
            </button>
            <button
              className="secondary"
              disabled={running}
              onClick={() => start("recommendations")}
            >
              Найти проверенные улучшения
            </button>
            <label>
              Эксперименты
              <select value={jobId} onChange={(e) => setJobId(e.target.value)}>
                <option value="">Выбрать</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.kind === "n_minus_one" ? "N−1" : "Рекомендации"} ·{" "}
                    {savedAt(j.created_at)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted">
            База: {run.title} · {result.summary.sample_count} отсчётов. Цель:{" "}
            {percent(result.effective_scenario.environment.target_availability)}
            % для каждого клиента.
          </p>
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
            {number(job.progress)} / {number(job.total)}
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
            Отменить эксперимент
          </button>
        </div>
      )}
      {job && ["cancelled", "interrupted", "failed"].includes(job.status) && (
        <p className="warning-note">
          {job.status === "cancelled"
            ? "Эксперимент отменён. Частичные результаты не выдаются за итоговые."
            : "Эксперимент не завершён. Можно запустить повторно."}
        </p>
      )}
      {report && (
        <>
          <div className="section-title">
            <h3>
              {report.kind === "n_minus_one"
                ? `Проверено аппаратов: ${report.summary.case_count}`
                : `Проверено вариантов: ${report.summary.case_count}`}
            </h3>
            <button
              className="secondary"
              onClick={() => download(`/experiments/${jobId}/report`)}
            >
              Скачать отчёт с доказательствами
            </button>
          </div>
          {report.kind === "n_minus_one" ? (
            <>
              <p className="insight-text">
                {report.summary.critical_count
                  ? `${report.summary.critical_count} аппаратов при дополнительном отказе уменьшают доступность хотя бы одного клиента.`
                  : "Дополнительный одиночный отказ не уменьшает доступность на проверенной сетке. Это не доказывает достижение цели исходным сценарием."}
              </p>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Аппарат</th>
                      {Object.keys(result?.series ?? {}).map((c) => (
                        <th key={c}>{c} · доступность / потери</th>
                      ))}
                      <th>Проверить вариант</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report.cases as Case[]).map((c) => (
                      <tr key={c.satellite_id}>
                        <td>{c.satellite_id}</td>
                        {Object.keys(result?.series ?? {}).map((id) => (
                          <td key={id}>
                            <strong>
                              {percent(c.clients[id].availability)}%
                            </strong>
                            <br />
                            <span
                              className={
                                c.lost_samples[id] ? "text-red" : "muted"
                              }
                            >
                              −{c.lost_samples[id]} отсч. · перерыв{" "}
                              {duration(c.clients[id].max_outage_s)}
                            </span>
                          </td>
                        ))}
                        <td>
                          <button
                            className="quiet"
                            onClick={() => applyFailure(c.satellite_id)}
                          >
                            Создать отказ
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="recommendation-list">
              {(report.cases as Candidate[]).map((c, i) => (
                <article className="recommendation" key={i}>
                  <div className="section-title">
                    <h3>{c.title}</h3>
                    <span
                      className={
                        c.supported_improvement
                          ? "status-pill text-green"
                          : "status-pill"
                      }
                    >
                      {c.supported_improvement
                        ? "Улучшение подтверждено"
                        : "Нет улучшения без потерь"}
                    </span>
                  </div>
                  <p>{c.limitation}</p>
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Клиент</th>
                          <th>Доступность</th>
                          <th>Выигрыш / потери отсчётов</th>
                          <th>Макс. перерыв</th>
                          <th>Цель</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.comparison.clients.map((m) => (
                          <tr key={m.client_id}>
                            <td>{m.client_id}</td>
                            <td>
                              {percent(m.a.availability)} →{" "}
                              {percent(m.b.availability)}%
                            </td>
                            <td>
                              +{m.gained_samples} / −{m.lost_samples}
                            </td>
                            <td>{duration(m.b.max_outage_s)}</td>
                            <td>
                              {m.b.target_met ? "Достигнута" : "Не достигнута"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <button
                    className="secondary"
                    onClick={() => onVariant(c.scenario, run!.revision_id)}
                  >
                    Открыть вариант в редакторе
                  </button>
                </article>
              ))}
            </div>
          )}
          <p className="muted">
            Выводы относятся к этой ревизии, дискретной сетке и модели
            организаторов. Это ограниченный набор экспериментов, а не
            доказательство глобального оптимума.
          </p>
        </>
      )}
    </section>
  );
}
