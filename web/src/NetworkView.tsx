import { useMemo, useState } from "react";
import { geoAzimuthalEquidistant, geoGraticule10, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import landData from "world-atlas/land-110m.json";
import { Globe2, Network as NetworkIcon, LocateFixed } from "lucide-react";
import type { Scenario, Snapshot } from "./types";

const planeColors = [
  "#7faaf5",
  "#b598ea",
  "#6ac9ad",
  "#e1b276",
  "#db8db2",
  "#89c4df",
];
// Natural Earth land polygons distributed by world-atlas. No remote map service.
const land = feature(landData as never, landData.objects.land as never);

type Props = {
  scenario: Scenario;
  snapshot: Snapshot | null;
  client: string;
  selected: string | null;
  onSelect: (id: string) => void;
  busy?: boolean;
};

export default function NetworkView({
  scenario,
  snapshot,
  client,
  selected,
  onSelect,
  busy,
}: Props) {
  const [view, setView] = useState<"map" | "graph">("map");
  const [hemisphere, setHemisphere] = useState<1 | -1>(1);
  const [allLinks, setAllLinks] = useState(false);
  const [labels, setLabels] = useState(false);
  const projection = useMemo(
    () =>
      geoAzimuthalEquidistant()
        .rotate([-70, -90 * hemisphere, 0])
        .scale(153)
        .translate([390, 258])
        .clipAngle(90),
    [hemisphere],
  );
  const path = useMemo(() => geoPath(projection), [projection]);
  const planeColor = (id: string) =>
    planeColors[
      Math.max(
        0,
        scenario.design.planes.findIndex((p) => p.id === id),
      ) % planeColors.length
    ];
  const route = snapshot?.clients[client]?.path ?? [];
  const routeSet = new Set(route);
  const routeEdges = new Set(
    route.slice(1).map((id, i) => JSON.stringify([route[i], id].sort())),
  );

  const nodes = useMemo(() => {
    if (!snapshot) return [];
    const all = [
      ...snapshot.satellites.map((s) => ({ ...s, kind: "satellite" as const })),
      ...snapshot.ground_sites.map((g) => ({ ...g, kind: g.role })),
    ];
    return all.map((node) => {
      let point: [number, number] | null;
      let shown = true;
      if (view === "map") {
        const lat =
          (Math.atan2(node.z_km, Math.hypot(node.x_km, node.y_km)) * 180) /
          Math.PI;
        const lon = (Math.atan2(node.y_km, node.x_km) * 180) / Math.PI;
        point = projection([lon, lat]);
        shown = lat * hemisphere >= 0;
      } else if (node.kind === "satellite") {
        const plane = scenario.design.planes.findIndex(
          (p) => p.id === node.plane_id,
        );
        const members = scenario.design.satellites
          .filter((s) => s.plane_id === node.plane_id)
          .sort((a, b) => a.id.localeCompare(b.id));
        const index = members.findIndex((s) => s.id === node.id);
        const angle = (index / members.length) * 2 * Math.PI - Math.PI / 2;
        const radius =
          100 + ((plane + 1) / scenario.design.planes.length) * 125;
        point = [
          390 + radius * Math.cos(angle),
          258 + radius * Math.sin(angle),
        ];
      } else {
        const members = snapshot.ground_sites.filter(
          (g) => g.role === node.kind,
        );
        const index = members.findIndex((g) => g.id === node.id);
        point = [
          node.kind === "client" ? 58 : 722,
          115 + ((index + 1) / (members.length + 1)) * 290,
        ];
      }
      return { ...node, point, shown };
    });
  }, [snapshot, view, projection, hemisphere, scenario]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hiddenRoute = route.some((id) => !byId.get(id)?.shown);

  return (
    <section
      className={`network-panel ${busy ? "refreshing" : ""}`}
      aria-label="Карта и топология сети"
    >
      <div className="scene-toolbar">
        <div className="segmented" aria-label="Представление сети">
          <button
            className={view === "map" ? "active" : ""}
            aria-pressed={view === "map"}
            onClick={() => setView("map")}
          >
            <Globe2 size={16} />
            Карта
          </button>
          <button
            className={view === "graph" ? "active" : ""}
            aria-pressed={view === "graph"}
            onClick={() => setView("graph")}
          >
            <NetworkIcon size={16} />
            Топология
          </button>
        </div>
        <div className="scene-options">
          {view === "map" && (
            <button
              className="quiet"
              onClick={() => setHemisphere(hemisphere === 1 ? -1 : 1)}
            >
              <LocateFixed size={15} />
              {hemisphere === 1 ? "Север" : "Юг"}
            </button>
          )}
          <label>
            <input
              type="checkbox"
              checked={allLinks}
              onChange={(e) => setAllLinks(e.target.checked)}
            />
            Все связи
          </label>
          <label>
            <input
              type="checkbox"
              checked={labels}
              onChange={(e) => setLabels(e.target.checked)}
            />
            ID
          </label>
        </div>
      </div>
      <svg
        className="network-svg"
        viewBox="0 0 780 520"
        role="group"
        aria-label={
          view === "map"
            ? "Полярная карта положений спутников и наземных пунктов"
            : "Схема всех узлов сети и выбранного маршрута"
        }
      >
        <defs>
          <radialGradient id="ocean">
            <stop stopColor="#142535" />
            <stop offset="1" stopColor="#101c28" />
          </radialGradient>
          <filter id="route-glow">
            <feGaussianBlur stdDeviation="2" />
          </filter>
        </defs>
        {view === "map" ? (
          <>
            <circle
              cx="390"
              cy="258"
              r="244"
              fill="none"
              stroke="#25384a"
              strokeWidth="1"
            />
            <circle cx="390" cy="258" r="240" fill="url(#ocean)" />
            <path
              d={path(land) ?? ""}
              fill="#203440"
              stroke="#385260"
              strokeWidth="0.75"
            />
            <path
              d={path(geoGraticule10()) ?? ""}
              fill="none"
              stroke="#4c6678"
              strokeOpacity="0.23"
              strokeWidth="0.65"
            />
            <circle cx="390" cy="258" r="3" fill="none" stroke="#718696" />
            <text x="399" y="250" className="map-coordinate">
              {hemisphere === 1 ? "90° N" : "90° S"}
            </text>
            <text
              x="390"
              y="515"
              textAnchor="middle"
              className="map-coordinate"
            >
              Полярная проекция · положения относительно Земли
            </text>
          </>
        ) : (
          <>
            {scenario.design.planes.map((plane, i) => (
              <circle
                key={plane.id}
                cx="390"
                cy="258"
                r={100 + ((i + 1) / scenario.design.planes.length) * 125}
                fill="none"
                stroke={planeColor(plane.id)}
                strokeOpacity="0.15"
                strokeDasharray="3 6"
              />
            ))}
            <text
              x="390"
              y="510"
              textAnchor="middle"
              className="map-coordinate"
            >
              Спутниковые плоскости · наземные пункты по краям
            </text>
          </>
        )}
        {snapshot?.edges.map(([a, b], i) => {
          const first = byId.get(a),
            second = byId.get(b);
          if (!first?.shown || !second?.shown || !first.point || !second.point)
            return null;
          const inRoute = routeEdges.has(JSON.stringify([a, b].sort()));
          const adjacent = selected === a || selected === b;
          if (!allLinks && !inRoute && !adjacent) return null;
          return (
            <line
              key={i}
              x1={first.point[0]}
              y1={first.point[1]}
              x2={second.point[0]}
              y2={second.point[1]}
              stroke={inRoute ? "#6ce9cc" : adjacent ? "#8cb7ec" : "#698398"}
              strokeWidth={inRoute ? 2.4 : 0.8}
              strokeOpacity={inRoute ? 1 : adjacent ? 0.7 : 0.23}
            />
          );
        })}
        {nodes
          .filter((n) => n.shown && n.point)
          .map((node) => {
            const [x, y] = node.point!;
            const satellite = node.kind === "satellite";
            const active = satellite ? node.active : node.online;
            const chosen = node.id === selected || node.id === client;
            const color = satellite
              ? active
                ? planeColor(node.plane_id)
                : "#647384"
              : node.kind === "gateway"
                ? "#e6b977"
                : "#6ce9cc";
            return (
              <g
                key={node.id}
                transform={`translate(${x} ${y})`}
                role="button"
                tabIndex={0}
                aria-label={`${satellite ? "Спутник" : node.kind === "gateway" ? "Шлюз" : "Клиент"} ${node.id}`}
                onClick={() => onSelect(node.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(node.id);
                  }
                }}
                className="map-node"
              >
                <title>
                  {node.id} ·{" "}
                  {satellite
                    ? node.state === "active"
                      ? "Активен"
                      : node.state === "failed"
                        ? "Отказ"
                        : "Не запущен"
                    : node.name}
                </title>
                <circle r="11" fill="transparent" />
                {(chosen || routeSet.has(node.id)) && (
                  <circle
                    r={satellite ? 9 : 12}
                    fill="none"
                    stroke={chosen ? "#edf8f6" : "#6ce9cc"}
                    strokeWidth="1"
                    strokeOpacity="0.7"
                  />
                )}
                {satellite ? (
                  <rect
                    x="-3.3"
                    y="-3.3"
                    width="6.6"
                    height="6.6"
                    rx="1.2"
                    transform="rotate(45)"
                    fill={active ? color : "#131e29"}
                    stroke={color}
                    strokeWidth="1.3"
                  />
                ) : node.kind === "gateway" ? (
                  <path
                    d="M0 -7 L7 6 L-7 6 Z"
                    fill={active ? color : "#131e29"}
                    stroke={color}
                  />
                ) : (
                  <circle
                    r="5.5"
                    fill={color}
                    stroke="#0b1119"
                    strokeWidth="2"
                  />
                )}
                {(!satellite || labels || chosen || routeSet.has(node.id)) && (
                  <text
                    x="12"
                    y="4"
                    fill={active ? "#d9e6ed" : "#8294a4"}
                    className="node-label"
                  >
                    {node.id}
                  </text>
                )}
              </g>
            );
          })}
        {!snapshot && (
          <g>
            <rect
              x="245"
              y="213"
              width="290"
              height="82"
              rx="10"
              fill="#101b26"
              stroke="#355064"
            />
            <text
              x="390"
              y="245"
              textAnchor="middle"
              className="scene-empty-title"
            >
              Сценарий готов к расчёту
            </text>
            <text
              x="390"
              y="272"
              textAnchor="middle"
              className="map-coordinate"
            >
              Запустите моделирование сети
            </text>
          </g>
        )}
      </svg>
      {hiddenRoute && view === "map" && (
        <button className="map-notice" onClick={() => setView("graph")}>
          Часть маршрута за пределами карты · Показать топологию
        </button>
      )}
      <div className="scene-footer">
        <div className="plane-legend">
          {scenario.design.planes.map((p) => (
            <span key={p.id}>
              <i style={{ background: planeColor(p.id) }} />
              {p.id}
            </span>
          ))}
        </div>
        <span>
          {snapshot
            ? `${nodes.filter((n) => n.kind === "satellite" && n.shown).length} из ${scenario.design.satellites.length} аппаратов в поле зрения`
            : `${scenario.design.satellites.length} аппаратов · ${scenario.design.planes.length} плоскости`}
        </span>
      </div>
    </section>
  );
}
