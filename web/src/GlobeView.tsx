import { useId, useMemo, useRef, useState } from "react";
import { geoOrthographic, geoPath, geoGraticule10 } from "d3-geo";
import { feature } from "topojson-client";
import landData from "world-atlas/land-110m.json";
import type { Snapshot } from "./types";
import { globePoint } from "./projection";

const land = feature(landData as never, landData.objects.land as never);
export default function GlobeView({
  snapshot,
  client,
  onSelect,
  allLinks,
  labels,
  camera: controlledCamera,
  onCamera,
}: {
  snapshot: Snapshot | null;
  client: string;
  onSelect: (id: string) => void;
  allLinks: boolean;
  labels: boolean;
  camera?: [number, number];
  onCamera?: (camera: [number, number]) => void;
}) {
  const [localCamera, setLocalCamera] = useState<[number, number]>([60, 60]);
  const uid = useId().replace(/:/g, "");
  const camera = controlledCamera ?? localCamera;
  const setCamera = onCamera ?? setLocalCamera;
  const drag = useRef<{
    x: number;
    y: number;
    camera: [number, number];
  } | null>(null);
  const projection = useMemo(
    () =>
      geoOrthographic()
        .rotate([-camera[0], -camera[1]])
        .scale(190)
        .translate([390, 258]),
    [camera],
  );
  const path = geoPath(projection);
  const nodes = [
    ...(snapshot?.satellites ?? []).map((s) => ({ ...s, kind: "satellite" })),
    ...(snapshot?.ground_sites ?? []).map((g) => ({
      ...g,
      active: g.online,
      kind: g.role,
    })),
  ];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const route = snapshot?.clients[client]?.path ?? [];
  const routeEdges = new Set(
    route.slice(1).map((id, i) => JSON.stringify([route[i], id].sort())),
  );
  const position = (n: { x_km: number; y_km: number; z_km: number }) =>
    globePoint(n.x_km, n.y_km, n.z_km, ...camera);
  const labelOffsets = new Map<string, [number, number]>();
  const boxes: { x: number; y: number; w: number; h: number }[] = [];
  if (labels) {
    for (const node of nodes
      .slice()
      .sort(
        (a, b) => Number(route.includes(b.id)) - Number(route.includes(a.id)),
      )) {
      const p = position(node);
      if (!p.visible) continue;
      const width = node.id.length * 7 + 5;
      for (const [dx, dy] of [
        [10, -9],
        [10, 16],
        [-width - 10, -9],
        [-width - 10, 16],
        [10, -28],
        [10, 34],
        [-width - 10, -28],
        [-width - 10, 34],
      ]) {
        const box = { x: p.x + dx, y: p.y + dy - 11, w: width, h: 16 };
        if (
          box.x < 153 ||
          box.x + box.w > 627 ||
          box.y < 5 ||
          box.y + box.h > 515 ||
          boxes.some(
            (b) =>
              box.x < b.x + b.w &&
              box.x + box.w > b.x &&
              box.y < b.y + b.h &&
              box.y + box.h > b.y,
          )
        )
          continue;
        boxes.push(box);
        labelOffsets.set(node.id, [dx, dy]);
        break;
      }
    }
  }
  const edgePath = (a: (typeof nodes)[number], b: (typeof nodes)[number]) => {
    let d = "",
      previous = false;
    for (let i = 0; i <= 40; i++) {
      const f = i / 40;
      const p = position({
        x_km: a.x_km + (b.x_km - a.x_km) * f,
        y_km: a.y_km + (b.y_km - a.y_km) * f,
        z_km: a.z_km + (b.z_km - a.z_km) * f,
      });
      if (p.visible) d += `${previous ? "L" : "M"}${p.x},${p.y} `;
      previous = p.visible;
    }
    return d;
  };
  return (
    <div className="globe-container">
      <svg
        className="network-svg globe-svg"
        viewBox="150 0 480 520"
        role="group"
        aria-label="Глобус: земные координаты сети"
        onPointerDown={(e) => {
          if ((e.target as Element).closest("[role=button]")) return;
          drag.current = { x: e.clientX, y: e.clientY, camera };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current) {
            const d = drag.current;
            setCamera([
              d.camera[0] - (e.clientX - d.x) * 0.3,
              Math.max(
                -90,
                Math.min(90, d.camera[1] + (e.clientY - d.y) * 0.3),
              ),
            ]);
          }
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <defs>
          <radialGradient id={`${uid}-water`} cx="32%" cy="25%" r="78%">
            <stop offset="0" stopColor="#285967" />
            <stop offset=".6" stopColor="#183c4b" />
            <stop offset="1" stopColor="#091c2b" />
          </radialGradient>
          <linearGradient id={`${uid}-land`} x1="0" y1="0" x2=".9" y2="1">
            <stop stopColor="#92a696" />
            <stop offset=".55" stopColor="#5c8078" />
            <stop offset="1" stopColor="#294d50" />
          </linearGradient>
          <radialGradient id={`${uid}-halo`}>
            <stop offset=".75" stopColor="#73c6bf" stopOpacity="0" />
            <stop offset=".86" stopColor="#8fc9c9" stopOpacity=".12" />
            <stop offset="1" stopColor="#8fc9c9" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="390" cy="258" r="222" fill={`url(#${uid}-halo)`} />
        <circle
          cx="390"
          cy="258"
          r="191"
          fill="none"
          stroke="#a0d3d3"
          strokeOpacity=".45"
          strokeWidth="1.5"
        />
        <circle cx="390" cy="258" r="190" fill={`url(#${uid}-water)`} />
        <path
          d={path(land) ?? ""}
          fill={`url(#${uid}-land)`}
          stroke="#a1b7a9"
          strokeWidth=".35"
        />
        <path
          d={path(geoGraticule10()) ?? ""}
          fill="none"
          stroke="#97bfc2"
          strokeWidth=".55"
          strokeOpacity=".22"
        />
        {snapshot?.edges
          .slice()
          .sort(
            (a, b) =>
              Number(routeEdges.has(JSON.stringify(a.slice(0, 2).sort()))) -
              Number(routeEdges.has(JSON.stringify(b.slice(0, 2).sort()))),
          )
          .map(([a, b], i) => {
            const first = byId.get(a),
              second = byId.get(b);
            const chosen = routeEdges.has(JSON.stringify([a, b].sort()));
            if (!first || !second || (!allLinks && !chosen)) return null;
            return (
              <g
                key={i}
                className={chosen ? "contact-edge route-edge" : "contact-edge"}
              >
                <path d={edgePath(first, second)} className="edge-outline" />
                <path d={edgePath(first, second)} className="edge-color" />
              </g>
            );
          })}
        {nodes.map((n) => {
          const p = position(n);
          if (!p.visible) return null;
          return (
            <g
              key={n.id}
              transform={`translate(${p.x} ${p.y})`}
              role="button"
              tabIndex={0}
              aria-label={`Объект ${n.id}`}
              onClick={() => onSelect(n.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(n.id);
                }
              }}
            >
              <title>{n.id}</title>
              <circle r="11" fill="transparent" />
              <circle
                r={n.kind === "satellite" ? 3 : 5}
                fill={
                  !n.active
                    ? "#586673"
                    : n.kind === "gateway"
                      ? "#e6b977"
                      : route.includes(n.id)
                        ? "#6ce9cc"
                        : "#8eaef2"
                }
                stroke={route.includes(n.id) ? "#e9fffa" : "#101e2b"}
              />
              {labelOffsets.has(n.id) && (
                <text
                  x={labelOffsets.get(n.id)![0]}
                  y={labelOffsets.get(n.id)![1]}
                  className="node-label"
                >
                  {n.id}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="globe-controls">
        <label>
          Долгота камеры
          <input
            aria-label="Долгота камеры"
            type="range"
            min="-180"
            max="180"
            value={((camera[0] + 540) % 360) - 180}
            onChange={(e) => setCamera([Number(e.target.value), camera[1]])}
          />
        </label>
        <label>
          Широта камеры
          <input
            aria-label="Широта камеры"
            type="range"
            min="-90"
            max="90"
            value={camera[1]}
            onChange={(e) => setCamera([camera[0], Number(e.target.value)])}
          />
        </label>
      </div>
    </div>
  );
}
