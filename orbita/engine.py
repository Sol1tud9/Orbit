"""UI-independent calculation pipeline shared by CLI and background API jobs."""

from collections.abc import Callable
from time import perf_counter

from . import __version__
from .analysis import summarize
from .geometry_adapter import geometry_hash, snapshot
from .routing import ROUTING_POLICY, explain, route
from .scenario import canonical_hash, validate_scenario
from .topology import build_topology


class CalculationCancelled(Exception):
    pass


def analyze_snapshot(scenario: dict, snap: dict) -> tuple[dict, dict]:
    topology = build_topology(scenario, snap)
    rows = {}
    for ground in scenario["ground_sites"]:
        if ground["role"] == "client":
            result = route(topology, ground["id"])
            rows[ground["id"]] = {
                "t_s": snap["t_s"],
                "client_id": ground["id"],
                **result,
                **explain(topology, ground["id"], result["path"]),
            }
    info = {
        "t_s": snap["t_s"],
        "active_satellites": len(topology.satellites),
        "isl_edges": sum(
            a in topology.satellites and b in topology.satellites
            for a, b, _ in snap["edges"]
        ),
        "ground_edges": sum(
            a not in topology.satellites or b not in topology.satellites
            for a, b, _ in snap["edges"]
        ),
        "component_count": len(topology.components),
        "components": topology.components,
        "online_gateways": sorted(topology.online_gateways),
    }
    return rows, info


def simulate(
    scenario: dict,
    progress: Callable[[int, int], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
) -> dict:
    scenario = validate_scenario(scenario)
    started = perf_counter()
    env = scenario["environment"]
    grid = range(0, env["horizon_s"], env["step_s"])
    series = {g["id"]: [] for g in scenario["ground_sites"] if g["role"] == "client"}
    network = []
    for index, t_s in enumerate(grid):
        if cancelled and cancelled():
            raise CalculationCancelled()
        snap = snapshot(scenario, t_s)
        rows, info = analyze_snapshot(scenario, snap)
        for client, row in rows.items():
            # Detailed facts are derived on demand from the same immutable run.
            series[client].append({k: v for k, v in row.items() if k != "facts"})
        network.append({k: v for k, v in info.items() if k != "components"})
        if progress and (index % 12 == 0 or index == len(grid) - 1):
            progress(index + 1, len(grid))
    summaries = {
        client: summarize(
            rows, env["step_s"], env["horizon_s"], env["target_availability"]
        )
        for client, rows in series.items()
    }
    return {
        "schema_version": "orbita-run-1.0",
        "effective_scenario": scenario,
        "provenance": {
            "engine_version": __version__,
            "geometry_sha256": geometry_hash(),
            "scenario_sha256": canonical_hash(scenario),
            "routing_policy": ROUTING_POLICY,
            "time_rule": "left_sample_half_open",
            "elapsed_s": perf_counter() - started,
        },
        "summary": {
            "sample_count": len(grid),
            "clients": summaries,
            "all_clients_target_met": all(m["target_met"] for m in summaries.values()),
        },
        "series": series,
        "network": network,
    }


def export_result(result: dict) -> dict:
    clients = list(result["series"])
    routes = [
        {"t_s": row["t_s"], "client_id": client, "path": list(row["path"])}
        for index in range(result["summary"]["sample_count"])
        for client in clients
        for row in [result["series"][client][index]]
    ]
    return {
        "schema_version": "cosmo-A-result-1.0",
        "effective_scenario": result["effective_scenario"],
        "routes": routes,
        "summary": result["summary"],
        "provenance": result["provenance"],
    }
