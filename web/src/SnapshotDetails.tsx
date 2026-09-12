import { useEffect, useState } from "react";
import { request } from "./api";
import { number } from "./format";
import type { Scenario, Snapshot, Sample } from "./types";

type Diagnostic = {
  alternative: Sample | null;
  route_satellites: {
    satellite_id: string;
    disconnected: boolean;
    alternative: Sample;
  }[];
  without_declared_outages: Sample;
  outage_removal_restores_path: boolean;
};
export default function SnapshotDetails({
  snapshot,
  client,
  scenario,
  onFailure,
}: {
  snapshot: Snapshot | null;
  client: string;
  scenario: Scenario;
  onFailure: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [diagnostic, setDiagnostic] = useState<Diagnostic | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setDiagnostic(null);
    setError("");
    if (!open || !snapshot) return;
    const controller = new AbortController();
    request<Diagnostic>(
      `/runs/${snapshot.run_id}/diagnostics/${snapshot.index}?client=${encodeURIComponent(client)}`,
      { signal: controller.signal },
    )
      .then((d) => {
        if (!controller.signal.aborted) setDiagnostic(d);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [open, snapshot, client]);
  if (!snapshot) return null;
  const edges = snapshot.edges.filter((e) =>
    `${e[0]} ${e[1]}`.toLowerCase().includes(query.toLowerCase()),
  );
  const ground = new Set(scenario.ground_sites.map((g) => g.id));
  return (
    <section className="snapshot-details">
      <details onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>Резервный маршрут и проверка причин</summary>
        {error && <p role="alert">{error}</p>}
        {!diagnostic ? (
          <p>Проверяем топологию выбранного отсчёта…</p>
        ) : (
          <>
            <h3>Следующий допустимый маршрут</h3>
            <p className="path-text">
              {diagnostic.alternative?.path.join(" → ") ||
                "Другой допустимый путь не найден."}
            </p>
            {diagnostic.alternative && (
              <p className="muted">
                {diagnostic.alternative.hop_count} переходов ·{" "}
                {number(diagnostic.alternative.distance_km!, 1)} км.
                Альтернативный путь может использовать общие аппараты.
              </p>
            )}
            <h3>Отказ аппарата выбранного маршрута</h3>
            <div className="diagnostic-nodes">
              {diagnostic.route_satellites.map((s) => (
                <div key={s.satellite_id}>
                  <strong>{s.satellite_id}</strong>
                  <span className={s.disconnected ? "text-red" : "text-green"}>
                    {s.disconnected ? "Путь пропадёт" : "Есть обход"}
                  </span>
                  <button
                    className="quiet"
                    onClick={() => onFailure(s.satellite_id)}
                  >
                    Задать отказ
                  </button>
                </div>
              ))}
            </div>
            <h3>Если убрать заданные отказы аппаратов и шлюзов</h3>
            <p>
              {diagnostic.outage_removal_restores_path
                ? "Связь восстанавливается: совместное устранение заданных отказов достаточно в этом отсчёте."
                : diagnostic.without_declared_outages.path.length
                  ? "Связь остаётся доступной."
                  : "Путь всё ещё отсутствует: одного устранения заданных отказов недостаточно."}
            </p>
            <p className="muted">
              Проверка относится только к выбранному моменту. Суточный вклад
              каждого аппарата оценивается в режиме устойчивости.
            </p>
          </>
        )}
      </details>
      <details>
        <summary>Таблица контактов · {snapshot.edges.length}</summary>
        <label className="contact-search">
          Поиск узла
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ID спутника или наземного пункта"
          />
        </label>
        <div className="table-scroll contacts-table">
          <table className="data-table">
            <thead>
              <tr>
                <th>Узел A</th>
                <th>Узел B</th>
                <th>Тип</th>
                <th>Длина, км</th>
              </tr>
            </thead>
            <tbody>
              {edges.map(([a, b, d], i) => (
                <tr key={i}>
                  <td>{a}</td>
                  <td>{b}</td>
                  <td>{ground.has(a) || ground.has(b) ? "Наземный" : "ISL"}</td>
                  <td>{number(d, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!edges.length && <p>Совпадений нет.</p>}
      </details>
    </section>
  );
}
