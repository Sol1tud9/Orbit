import {
  Pause,
  Play,
  SkipBack,
  SkipForward,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { RunResult, Scenario } from "./types";
import { percent, reasonColor, time } from "./format";

type Props = {
  result: RunResult;
  scenario: Scenario;
  index: number;
  client: string;
  playing: boolean;
  onIndex: (i: number) => void;
  onClient: (id: string) => void;
  onPlaying: (value: boolean) => void;
};

export default function Timeline({
  result,
  scenario,
  index,
  client,
  playing,
  onIndex,
  onClient,
  onPlaying,
}: Props) {
  const count = result.summary.sample_count,
    step = scenario.environment.step_s,
    horizon = scenario.environment.horizon_s;
  const move = (i: number) => onIndex(Math.max(0, Math.min(count - 1, i)));
  const nextOutage = (direction: 1 | -1) => {
    const intervals = result.summary.clients[client]?.outages ?? [];
    const candidate =
      direction === 1
        ? intervals.find((o) => o.start_s > index * step)
        : [...intervals].reverse().find((o) => o.start_s < index * step);
    if (candidate) move(candidate.start_s / step);
  };
  return (
    <section
      className="timeline-panel"
      aria-label="Временная шкала доступности"
    >
      <div className="timeline-head">
        <div>
          <span className="eyebrow">СОСТОЯНИЕ СЕТИ ВО ВРЕМЕНИ</span>
          <h2>Доступность связи</h2>
        </div>
        <div className="playback">
          <button
            className="icon-button"
            aria-label="Предыдущий отсчёт"
            onClick={() => move(index - 1)}
            disabled={index === 0}
          >
            <ChevronLeft size={18} />
          </button>
          <button
            className="play-button"
            aria-label={playing ? "Пауза" : "Воспроизвести"}
            onClick={() => onPlaying(!playing)}
          >
            {playing ? <Pause size={15} /> : <Play size={15} />}
          </button>
          <button
            className="icon-button"
            aria-label="Следующий отсчёт"
            onClick={() => move(index + 1)}
            disabled={index === count - 1}
          >
            <ChevronRight size={18} />
          </button>
          <output className="time-output" aria-label="Выбранное время">
            {time(index * step)}
          </output>
          <span className="muted">/ {time(horizon)}</span>
        </div>
        <div className="timeline-legend">
          <span>
            <i className="swatch connected" />
            Есть путь
          </span>
          <span>
            <i className="swatch disconnected" />
            Нет пути
          </span>
          <span>
            <i className="swatch uncovered" />
            Нет покрытия
          </span>
          {scenario.gateway_outages.length > 0 && (
            <span>
              <i className="swatch offline" />
              Шлюзы отключены
            </span>
          )}
        </div>
      </div>
      <div className="timeline-axis">
        <span>Клиент</span>
        <div>
          {Array.from({ length: 7 }, (_, i) => (
            <span key={i}>{time((horizon * i) / 6).slice(0, 5)}</span>
          ))}
        </div>
        <span>За период</span>
      </div>
      {Object.entries(result.series).map(([id, rows]) => {
        const segments: {
          start: number;
          end: number;
          reason: (typeof rows)[number]["reason"];
        }[] = [];
        rows.forEach((row, i) => {
          const last = segments.at(-1);
          if (last && last.reason === row.reason) last.end = i + 1;
          else segments.push({ start: i, end: i + 1, reason: row.reason });
        });
        return (
          <div
            className={`timeline-row ${id === client ? "selected" : ""}`}
            key={id}
          >
            <button onClick={() => onClient(id)} aria-pressed={id === client}>
              {id}
            </button>
            <div
              className="track"
              onClick={(e) => {
                const bounds = e.currentTarget.getBoundingClientRect();
                onClient(id);
                move(
                  Math.floor(
                    ((e.clientX - bounds.left) / bounds.width) * count,
                  ),
                );
              }}
            >
              <svg
                viewBox={`0 0 ${count} 24`}
                preserveAspectRatio="none"
                role="img"
                aria-label={`Доступность ${id} за весь период`}
              >
                {segments.map((segment) => (
                  <rect
                    key={segment.start}
                    x={segment.start}
                    y="3"
                    width={segment.end - segment.start}
                    height="18"
                    rx="0"
                    fill={reasonColor[segment.reason]}
                    fillOpacity={segment.reason === "connected" ? 0.68 : 0.95}
                  />
                ))}
              </svg>
              <span
                className="time-cursor"
                style={{ left: `${((index + 0.5) / count) * 100}%` }}
              />
              {[...scenario.failures, ...scenario.gateway_outages]
                .flatMap((o) => [o.start_s, o.end_s])
                .filter((t, i, a) => t < horizon && a.indexOf(t) === i)
                .map((t) => (
                  <span
                    key={t}
                    className="failure-marker"
                    title={`Граница периода недоступности: ${time(t)}`}
                    style={{ left: `${(t / horizon) * 100}%` }}
                  />
                ))}
            </div>
            <span
              className={
                result.summary.clients[id].target_met
                  ? "text-green"
                  : "text-amber"
              }
            >
              {percent(result.summary.clients[id].availability)}%
            </span>
          </div>
        );
      })}
      <div className="timeline-bottom">
        <div className="outage-nav">
          <button
            onClick={() => nextOutage(-1)}
            disabled={
              !result.summary.clients[client]?.outages.some(
                (o) => o.start_s < index * step,
              )
            }
          >
            <SkipBack size={14} />
            Предыдущий перерыв
          </button>
          <button
            onClick={() => nextOutage(1)}
            disabled={
              !result.summary.clients[client]?.outages.some(
                (o) => o.start_s > index * step,
              )
            }
          >
            Следующий перерыв
            <SkipForward size={14} />
          </button>
        </div>
        <input
          aria-label="Отсчёт времени"
          type="range"
          min="0"
          max={count - 1}
          step="1"
          value={index}
          onChange={(e) => move(Number(e.target.value))}
        />
        <label className="step-input">
          <span>Шаг {step} с · отсчёт</span>
          <input
            aria-label="Номер отсчёта"
            type="number"
            min="1"
            max={count}
            step="1"
            value={index + 1}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isFinite(value)) move(Math.trunc(value) - 1);
            }}
          />
          <span>/ {count}</span>
        </label>
      </div>
    </section>
  );
}
