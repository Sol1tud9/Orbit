import { useEffect, useState } from "react";
import {
  Plus,
  Trash2,
  Save,
  RotateCcw,
  Download,
  GitBranch,
} from "lucide-react";
import { ApiError, request } from "./api";
import { savedAt } from "./format";
import type { Scenario, Revision } from "./types";

const environmentLabels: Record<string, string> = {
  altitude_km: "Высота, км",
  inclination_deg: "Наклонение, °",
  earth_angle0_deg: "Начальный угол Земли, °",
  horizon_s: "Горизонт, с",
  step_s: "Шаг, с",
  min_elevation_deg: "Минимальное возвышение, °",
  isl_range_km: "Дальность ISL, км",
  target_availability: "Целевая доступность, доля",
};
type Row = Record<string, unknown>;
type Column = {
  key: string;
  label: string;
  options?: string[];
  optionLabels?: Record<string, string>;
  numeric?: boolean;
};

export function saveJson(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Collection({
  title,
  rows,
  columns,
  onChange,
  onAdd,
}: {
  title: string;
  rows: Row[];
  columns: Column[];
  onChange: (rows: Row[]) => void;
  onAdd: () => void;
}) {
  return (
    <section className="editor-section">
      <div className="section-title">
        <h3>
          {title} <span className="count-badge">{rows.length}</span>
        </h3>
        <button className="secondary" onClick={onAdd}>
          <Plus size={14} />
          Добавить
        </button>
      </div>
      <div className="table-scroll">
        <table className="data-table editor-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
              <th>Удаление</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c.key}>
                    {c.options ? (
                      <select
                        aria-label={`${title} ${i + 1}: ${c.label}`}
                        value={String(row[c.key])}
                        onChange={(e) =>
                          onChange(
                            rows.map((r, j) =>
                              j === i ? { ...r, [c.key]: e.target.value } : r,
                            ),
                          )
                        }
                      >
                        {c.options.map((o) => (
                          <option key={o} value={o}>
                            {c.optionLabels?.[o] ?? o}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        aria-label={`${title} ${i + 1}: ${c.label}`}
                        type={c.numeric ? "number" : "text"}
                        step="any"
                        value={String(row[c.key] ?? "")}
                        onChange={(e) =>
                          onChange(
                            rows.map((r, j) =>
                              j === i
                                ? {
                                    ...r,
                                    [c.key]:
                                      c.numeric && e.target.value !== ""
                                        ? Number(e.target.value)
                                        : e.target.value,
                                  }
                                : r,
                            ),
                          )
                        }
                      />
                    )}
                  </td>
                ))}
                <td>
                  <button
                    className="icon-button danger"
                    aria-label={`Удалить: ${title} ${i + 1}`}
                    onClick={() => onChange(rows.filter((_, j) => j !== i))}
                  >
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="empty-note">События не заданы.</p>}
      </div>
    </section>
  );
}

export default function ScenarioEditor({
  scenario,
  parentId,
  onApply,
}: {
  scenario: Scenario;
  parentId: string | null;
  onApply: (scenario: Scenario, revisionId: string) => void;
}) {
  const [value, setValue] = useState(() => structuredClone(scenario));
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Revision | null>(null);
  const [library, setLibrary] = useState<Revision[]>([]);
  const [origin, setOrigin] = useState(parentId);
  useEffect(() => {
    request<Revision[]>("/revisions")
      .then(setLibrary)
      .catch((e) => setError(e));
  }, []);
  const changed = JSON.stringify(value) !== JSON.stringify(scenario);
  const update = (part: Partial<Scenario>) => {
    setValue((v) => ({ ...v, ...part }));
    setSaved(null);
  };
  const unique = (prefix: string, rows: { id: string }[]) => {
    let n = 1;
    while (rows.some((r) => r.id === `${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  };
  const save = async (apply: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const revision = await request<Revision>("/revisions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(origin ? { "X-Orbita-Parent-Revision": origin } : {}),
        },
        body: JSON.stringify(value),
      });
      setSaved(revision);
      setOrigin(revision.id);
      setLibrary((l) => [revision, ...l]);
      if (apply) onApply(revision.scenario!, revision.id);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const d = value.design;
  return (
    <section className="product-panel editor" aria-label="Редактор сценария">
      <div className="panel-intro">
        <div>
          <h2>Условия и состав сети</h2>
          <p>Измените параметры и сохраните новый вариант для расчёта.</p>
        </div>
        <span className="status-pill">
          <GitBranch size={14} />
          {changed ? "Есть изменения" : "Исходный вариант"}
        </span>
      </div>
      <div className="editor-actions">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            setValue(structuredClone(scenario));
            setError(null);
            setSaved(null);
            setOrigin(parentId);
          }}
        >
          <RotateCcw size={15} />
          Сбросить правки
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => save(false)}
        >
          <Save size={15} />
          Сохранить ревизию
        </button>
        <button className="primary" disabled={busy} onClick={() => save(true)}>
          {busy ? "Проверяем…" : "Применить к рабочей области"}
        </button>
      </div>
      {error && (
        <div className="error-panel" role="alert">
          <div>
            <strong>{error.message}</strong>
            <ul>
              {error.issues?.map((e, i) => (
                <li key={i}>
                  {e.path}: {e.message}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {saved && (
        <div className="success-note" role="status">
          Вариант сохранён.{" "}
          <button
            className="quiet"
            onClick={() => saveJson("orbita-scenario.json", saved.scenario)}
          >
            <Download size={14} />
            Скачать JSON
          </button>
        </div>
      )}
      <div className="editor-grid">
        <label>
          Название
          <input
            value={value.meta.title}
            onChange={(e) =>
              update({ meta: { ...value.meta, title: e.target.value } })
            }
          />
        </label>
        <label>
          ID сценария
          <input
            value={value.meta.id}
            onChange={(e) =>
              update({ meta: { ...value.meta, id: e.target.value } })
            }
          />
        </label>
        <label>
          Очередь развёртывания
          <select
            value={d.launch_stage}
            onChange={(e) =>
              update({ design: { ...d, launch_stage: Number(e.target.value) } })
            }
          >
            {[1, 2, 3].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label>
          Открыть сохранённую ревизию
          <select
            aria-label="Открыть ревизию"
            value=""
            onChange={async (e) => {
              if (!e.target.value) return;
              try {
                const r = await request<Revision>(
                  `/revisions/${e.target.value}`,
                );
                setValue(r.scenario!);
                setOrigin(r.id);
                setSaved(r);
                setError(null);
              } catch (e) {
                setError(e as ApiError);
              }
            }}
          >
            <option value="">Выбрать из библиотеки</option>
            {library.map((r) => (
              <option value={r.id} key={r.id}>
                {r.title} · {savedAt(r.created_at)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <section className="editor-section">
        <h3>Окружение</h3>
        <div className="editor-grid">
          {Object.entries(environmentLabels).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="number"
                step="any"
                value={value.environment[key as keyof Scenario["environment"]]}
                onChange={(e) =>
                  update({
                    environment: {
                      ...value.environment,
                      [key]:
                        e.target.value === "" ? "" : Number(e.target.value),
                    },
                  })
                }
              />
            </label>
          ))}
        </div>
      </section>
      <Collection
        title="Плоскости"
        rows={d.planes}
        columns={[
          { key: "id", label: "ID" },
          { key: "raan_deg", label: "RAAN, °", numeric: true },
          { key: "phase_deg", label: "Фаза, °", numeric: true },
        ]}
        onChange={(rows) =>
          update({
            design: { ...d, planes: rows as Scenario["design"]["planes"] },
          })
        }
        onAdd={() =>
          update({
            design: {
              ...d,
              planes: [
                ...d.planes,
                { id: unique("P", d.planes), raan_deg: 0, phase_deg: 0 },
              ],
            },
          })
        }
      />
      <Collection
        title="Спутники"
        rows={d.satellites}
        columns={[
          { key: "id", label: "ID" },
          {
            key: "plane_id",
            label: "Плоскость",
            options: d.planes.map((p) => p.id),
          },
          { key: "slot_deg", label: "Положение, °", numeric: true },
          { key: "launch_batch", label: "Очередь", numeric: true },
        ]}
        onChange={(rows) =>
          update({
            design: {
              ...d,
              satellites: rows as Scenario["design"]["satellites"],
            },
          })
        }
        onAdd={() =>
          update({
            design: {
              ...d,
              satellites: [
                ...d.satellites,
                {
                  id: unique("S", d.satellites),
                  plane_id: d.planes[0]?.id ?? "",
                  slot_deg: 0,
                  launch_batch: 1,
                },
              ],
            },
          })
        }
      />
      <Collection
        title="Наземные пункты"
        rows={value.ground_sites}
        columns={[
          { key: "id", label: "ID" },
          { key: "name", label: "Название" },
          {
            key: "role",
            label: "Роль",
            options: ["client", "gateway"],
            optionLabels: { client: "Клиент", gateway: "Шлюз" },
          },
          { key: "lat_deg", label: "Широта, °", numeric: true },
          { key: "lon_deg", label: "Долгота, °", numeric: true },
        ]}
        onChange={(rows) =>
          update({ ground_sites: rows as Scenario["ground_sites"] })
        }
        onAdd={() =>
          update({
            ground_sites: [
              ...value.ground_sites,
              {
                id: unique("G", value.ground_sites),
                name: "Новый пункт",
                role: "client",
                lat_deg: 65,
                lon_deg: 60,
              },
            ],
          })
        }
      />
      <Collection
        title="Отказы аппаратов"
        rows={value.failures}
        columns={[
          {
            key: "satellite_id",
            label: "Аппарат",
            options: d.satellites.map((s) => s.id),
          },
          { key: "start_s", label: "Начало, с", numeric: true },
          { key: "end_s", label: "Конец, с", numeric: true },
        ]}
        onChange={(rows) => update({ failures: rows as Scenario["failures"] })}
        onAdd={() =>
          update({
            failures: [
              ...value.failures,
              {
                satellite_id: d.satellites[0]?.id ?? "",
                start_s: 0,
                end_s: value.environment.horizon_s,
              },
            ],
          })
        }
      />
      <Collection
        title="Отключения шлюзов"
        rows={value.gateway_outages}
        columns={[
          {
            key: "gateway_id",
            label: "Шлюз",
            options: value.ground_sites
              .filter((g) => g.role === "gateway")
              .map((g) => g.id),
          },
          { key: "start_s", label: "Начало, с", numeric: true },
          { key: "end_s", label: "Конец, с", numeric: true },
        ]}
        onChange={(rows) =>
          update({ gateway_outages: rows as Scenario["gateway_outages"] })
        }
        onAdd={() =>
          update({
            gateway_outages: [
              ...value.gateway_outages,
              {
                gateway_id:
                  value.ground_sites.find((g) => g.role === "gateway")?.id ??
                  "",
                start_s: 0,
                end_s: value.environment.horizon_s,
              },
            ],
          })
        }
      />
    </section>
  );
}
