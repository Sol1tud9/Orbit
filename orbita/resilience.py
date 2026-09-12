from copy import deepcopy
from time import perf_counter
from . import __version__

from .analysis import summarize
from .comparison import compare_results
from .engine import CalculationCancelled, analyze_snapshot, simulate
from .geometry_adapter import snapshot
from .routing import route
from .topology import build_topology


def without_satellite(snap, satellite_id):
    return {
        **snap,
        "satellites": [
            {**s, "active": False} if s["id"] == satellite_id else s
            for s in snap["satellites"]
        ],
        "edges": [e for e in snap["edges"] if satellite_id not in e[:2]],
    }


def snapshot_diagnostics(scenario, t_s, client):
    snap = snapshot(scenario, t_s)
    topology = build_topology(scenario, snap)
    primary = route(topology, client)
    alternatives = []
    for a, b in zip(primary["path"], primary["path"][1:]):
        altered = {**snap, "edges": [e for e in snap["edges"] if set(e[:2]) != {a, b}]}
        alternative = route(build_topology(scenario, altered), client)
        if alternative["path"]:
            alternatives.append(alternative)
    alternate = min(
        alternatives,
        key=lambda r: (r["hop_count"], r["distance_km"], r["path"]),
        default=None,
    )
    critical = []
    for satellite_id in primary["path"][1:-1]:
        alternate_node = route(
            build_topology(scenario, without_satellite(snap, satellite_id)), client
        )
        critical.append(
            {
                "satellite_id": satellite_id,
                "disconnected": not alternate_node["path"],
                "alternative": alternate_node,
            }
        )
    repaired = deepcopy(scenario)
    repaired["failures"] = []
    repaired["gateway_outages"] = []
    restored = route(build_topology(repaired, snapshot(repaired, t_s)), client)
    return {
        "t_s": t_s,
        "client_id": client,
        "primary": primary,
        "alternative": alternate,
        "route_satellites": critical,
        "without_declared_outages": restored,
        "outage_removal_restores_path": not primary["path"] and bool(restored["path"]),
    }


def n_minus_one(scenario, baseline, progress=None, cancelled=None):
    started = perf_counter()
    clients = list(baseline["series"])
    candidates = [
        s["id"]
        for s in scenario["design"]["satellites"]
        if s["launch_batch"] <= scenario["design"]["launch_stage"]
    ]
    env = scenario["environment"]
    grid = range(0, env["horizon_s"], env["step_s"])
    accumulators = {sat: {c: [] for c in clients} for sat in candidates}
    total = len(grid) * max(1, len(candidates))
    done = 0
    for index, t_s in enumerate(grid):
        if cancelled and cancelled():
            raise CalculationCancelled()
        snap = snapshot(scenario, t_s)
        for sat in candidates:
            if cancelled and cancelled():
                raise CalculationCancelled()
            rows, _ = analyze_snapshot(scenario, without_satellite(snap, sat))
            for client in clients:
                row = rows[client]
                accumulators[sat][client].append(
                    {
                        "t_s": t_s,
                        "path": bool(row["path"]),
                        "reason": row["reason"],
                        "visible_satellite_ids": bool(row["visible_satellite_ids"]),
                        "hop_count": row["hop_count"],
                        "distance_km": row["distance_km"],
                    }
                )
            done += 1
        if progress:
            progress(done if candidates else index + 1, total)
    cases = []
    for sat, series in accumulators.items():
        metrics = {
            c: summarize(
                rows, env["step_s"], env["horizon_s"], env["target_availability"]
            )
            for c, rows in series.items()
        }
        for metric in metrics.values():
            metric.pop("route_switches")
        losses = {
            c: baseline["summary"]["clients"][c]["reachable_samples"]
            - metrics[c]["reachable_samples"]
            for c in clients
        }
        cases.append(
            {
                "satellite_id": sat,
                "clients": metrics,
                "lost_samples": losses,
                "worst_loss": max(losses.values(), default=0),
                "total_loss": sum(losses.values()),
            }
        )
    cases.sort(key=lambda x: (-x["worst_loss"], -x["total_loss"], x["satellite_id"]))
    return {
        "schema_version": "orbita-experiment-1.0",
        "kind": "n_minus_one",
        "effective_scenario": scenario,
        "baseline_provenance": baseline["provenance"],
        "provenance": {
            **baseline["provenance"],
            "elapsed_s": perf_counter() - started,
            "experiment_policy": "additional-full-horizon-single-satellite-outage-v1",
            "engine_version": __version__,
        },
        "cases": cases,
        "summary": {
            "case_count": len(cases),
            "critical_count": sum(c["total_loss"] > 0 for c in cases),
            "sample_count": len(grid),
        },
        "baseline": baseline["summary"],
    }


def recommendation_candidates(scenario):
    candidates = []
    if scenario["failures"] or scenario["gateway_outages"]:
        repaired = deepcopy(scenario)
        repaired["failures"] = []
        repaired["gateway_outages"] = []
        candidates.append(
            (
                "Восстановить аппараты и шлюзы",
                repaired,
                "Контрфактическая оценка устранения всех заданных отказов; стоимость и возможность ремонта не моделируются.",
            )
        )
    if scenario["design"]["launch_stage"] < 3:
        launched = deepcopy(scenario)
        launched["design"]["launch_stage"] += 1
        candidates.append(
            (
                "Развернуть следующую очередь",
                launched,
                "Включение следующей очереди из исходного состава.",
            )
        )
    for increase in (1000, 2000):
        value = min(10000, scenario["environment"]["isl_range_km"] + increase)
        if value == scenario["environment"]["isl_range_km"] or any(
            s["environment"]["isl_range_km"] == value for _, s, _ in candidates
        ):
            continue
        candidate = deepcopy(scenario)
        candidate["environment"]["isl_range_km"] = value
        candidates.append(
            (
                f"Дальность ISL {value:g} км",
                candidate,
                "Требование к дальности в заданной геометрической модели; радиобюджет и стоимость оборудования не оценивались.",
            )
        )
    return candidates


def recommendations(scenario, baseline, progress=None, cancelled=None):
    started = perf_counter()
    candidates = recommendation_candidates(scenario)
    count = baseline["summary"]["sample_count"]
    cases = []
    for index, (title, candidate, limitation) in enumerate(candidates):
        candidate["meta"]["title"] = f"{scenario['meta']['title']} · {title}"
        result = simulate(
            candidate,
            progress=lambda done, total: progress(
                index * count + done, max(1, len(candidates)) * count
            )
            if progress
            else None,
            cancelled=cancelled,
        )
        comparison = compare_results(baseline, result)
        no_loss = all(c["lost_samples"] == 0 for c in comparison["clients"])
        gain = sum(c["gained_samples"] for c in comparison["clients"])
        cases.append(
            {
                "title": title,
                "limitation": limitation,
                "scenario": candidate,
                "summary": result["summary"],
                "provenance": result["provenance"],
                "comparison": comparison,
                "supported_improvement": no_loss and gain > 0,
                "gained_samples": gain,
            }
        )
    cases.sort(
        key=lambda c: (-c["supported_improvement"], -c["gained_samples"], c["title"])
    )
    return {
        "schema_version": "orbita-experiment-1.0",
        "kind": "recommendations",
        "effective_scenario": scenario,
        "baseline_provenance": baseline["provenance"],
        "provenance": {
            **baseline["provenance"],
            "elapsed_s": perf_counter() - started,
            "experiment_policy": "bounded-full-grid-candidates-v1",
            "engine_version": __version__,
        },
        "baseline": baseline["summary"],
        "cases": cases,
        "summary": {
            "case_count": len(cases),
            "improvement_count": sum(c["supported_improvement"] for c in cases),
            "sample_count": count,
        },
    }
