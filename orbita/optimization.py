from copy import deepcopy
from math import prod
from random import Random
from time import perf_counter

from pydantic import BaseModel, ConfigDict, Field

from . import __version__
from .comparison import compare_results
from .engine import CalculationCancelled, simulate
from .scenario import canonical_hash, validate_scenario


class SearchOptions(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    seed: int = Field(default=2026, ge=0, le=2147483647)
    budget: int = Field(default=12, ge=1, le=24)
    max_isl_range_km: float | None = Field(
        default=None, gt=0, le=10000, allow_inf_nan=False
    )
    phase_shift_deg: float = Field(default=15, ge=0, le=45, allow_inf_nan=False)
    include_next_stages: bool = True


def search_plan(scenario, options=None):
    settings = SearchOptions.model_validate(options or {}).model_dump()
    current_range = scenario["environment"]["isl_range_km"]
    upper = settings["max_isl_range_km"]
    if upper is None:
        upper = min(10000, current_range + 2000)
    if upper < current_range:
        raise ValueError(
            "Верхняя дальность не может быть меньше дальности базового сценария"
        )
    settings["max_isl_range_km"] = upper
    stage = scenario["design"]["launch_stage"]
    satellites = scenario["design"]["satellites"]
    stages = [stage]
    if settings["include_next_stages"]:
        for value in range(stage + 1, 4):
            if any(s["launch_batch"] == value for s in satellites):
                stages.append(value)
    ranges = list(dict.fromkeys([current_range, (current_range + upper) / 2, upper]))
    plane_ids = sorted(
        {s["plane_id"] for s in satellites if s["launch_batch"] <= max(stages)}
    )
    shift = settings["phase_shift_deg"]
    phase_values = [0, -shift, shift] if shift else [0]
    axes = [stages, ranges] + [phase_values for _ in plane_ids[1:]]
    combinations = prod(len(axis) for axis in axes)
    count = min(settings["budget"], combinations - 1)
    if count == combinations - 1:
        ranks = list(range(1, combinations))
    else:
        rng = Random(settings["seed"])
        selected = set()
        while len(selected) < count:
            selected.add(rng.randrange(1, combinations))
        ranks = sorted(selected)
    candidates = []
    for rank in ranks:
        remaining = rank
        values = []
        for axis in axes:
            values.append(axis[remaining % len(axis)])
            remaining //= len(axis)
        candidate = deepcopy(scenario)
        candidate["design"]["launch_stage"] = values[0]
        candidate["environment"]["isl_range_km"] = values[1]
        offsets = dict(zip(plane_ids[1:], values[2:]))
        for plane in candidate["design"]["planes"]:
            offset = offsets.get(plane["id"], 0)
            if offset:
                plane["phase_deg"] = (plane["phase_deg"] + offset) % 360
        title = f"Вариант {len(candidates) + 1}"
        candidate["meta"]["title"] = f"{scenario['meta']['title']} · {title}"
        validate_scenario(candidate)
        candidates.append(
            {
                "key": str(rank),
                "title": title,
                "scenario": candidate,
                "phase_offsets": offsets,
            }
        )
    return {
        "options": settings,
        "space_size": str(combinations),
        "exhaustive": count == combinations - 1,
        "anchor_plane": plane_ids[0] if plane_ids else None,
        "axes": {
            "launch_stage": stages,
            "isl_range_km": ranges,
            "phase_offsets_deg": phase_values,
            "phase_plane_ids": plane_ids[1:],
        },
        "candidates": candidates,
    }


def objectives(scenario, summary):
    metrics = list(summary["clients"].values())
    return {
        "worst_reachable_samples": min(m["reachable_samples"] for m in metrics),
        "worst_availability": min(m["availability"] for m in metrics),
        "worst_outage_s": max(m["max_outage_s"] for m in metrics),
        "deployed_satellites": sum(
            s["launch_batch"] <= scenario["design"]["launch_stage"]
            for s in scenario["design"]["satellites"]
        ),
        "isl_range_km": scenario["environment"]["isl_range_km"],
    }


def dominates(a, b):
    left = (
        -a["worst_reachable_samples"],
        a["worst_outage_s"],
        a["deployed_satellites"],
        a["isl_range_km"],
    )
    right = (
        -b["worst_reachable_samples"],
        b["worst_outage_s"],
        b["deployed_satellites"],
        b["isl_range_km"],
    )
    return all(x <= y for x, y in zip(left, right)) and any(
        x < y for x, y in zip(left, right)
    )


def optimize(scenario, baseline, options=None, progress=None, cancelled=None):
    started = perf_counter()
    if canonical_hash(scenario) != canonical_hash(baseline["effective_scenario"]):
        raise ValueError("Базовый расчёт не соответствует сценарию")
    plan = search_plan(scenario, options)
    count = baseline["summary"]["sample_count"]
    cases = [
        {
            "key": "0",
            "title": "Базовый вариант",
            "is_baseline": True,
            "scenario": scenario,
            "summary": baseline["summary"],
            "provenance": baseline["provenance"],
            "phase_offsets": {},
            "objectives": objectives(scenario, baseline["summary"]),
            "comparison": compare_results(baseline, baseline),
            "supported_improvement": False,
        }
    ]
    for index, candidate in enumerate(plan["candidates"]):
        if cancelled and cancelled():
            raise CalculationCancelled()
        result = simulate(
            candidate["scenario"],
            progress=lambda done, total: progress(
                index * count + done, len(plan["candidates"]) * count
            )
            if progress
            else None,
            cancelled=cancelled,
        )
        comparison = compare_results(baseline, result)
        if not comparison["compatible"]:
            raise ValueError(
                "Нужен пересчёт базы текущей версией геометрии и маршрутизации"
            )
        cases.append(
            {
                **candidate,
                "is_baseline": False,
                "summary": result["summary"],
                "provenance": result["provenance"],
                "comparison": comparison,
                "objectives": objectives(candidate["scenario"], result["summary"]),
                "supported_improvement": all(
                    c["lost_samples"] == 0 for c in comparison["clients"]
                )
                and any(c["gained_samples"] > 0 for c in comparison["clients"]),
            }
        )
    if cancelled and cancelled():
        raise CalculationCancelled()
    for candidate in cases:
        candidate["pareto"] = not any(
            dominates(other["objectives"], candidate["objectives"]) for other in cases
        )
    return {
        "schema_version": "orbita-experiment-1.0",
        "kind": "optimization",
        "effective_scenario": scenario,
        "baseline": baseline["summary"],
        "baseline_provenance": baseline["provenance"],
        "provenance": {
            **baseline["provenance"],
            "engine_version": __version__,
            "elapsed_s": perf_counter() - started,
            "experiment_policy": "seeded-grid-pareto-v1",
        },
        "search": {k: v for k, v in plan.items() if k != "candidates"},
        "cases": cases,
        "summary": {
            "case_count": len(cases) - 1,
            "pareto_count": sum(c["pareto"] for c in cases),
            "improvement_count": sum(c["supported_improvement"] for c in cases),
            "sample_count": count,
        },
    }
