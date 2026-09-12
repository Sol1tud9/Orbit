"""Exact sample-based metrics. No interpolation and no cyclic outage merging."""

from collections import Counter


def summarize(samples: list[dict], step_s: int, horizon_s: int, target: float) -> dict:
    if not samples:
        raise ValueError("A complete run must contain at least one sample")
    intervals = []
    current = None
    for row in samples:
        if not row["path"]:
            if current is None:
                current = {"start_s": row["t_s"], "reason_samples": {}}
            reasons = current["reason_samples"]
            reasons[row["reason"]] = reasons.get(row["reason"], 0) + 1
        elif current is not None:
            current.update(end_s=row["t_s"], duration_s=row["t_s"] - current["start_s"])
            intervals.append(current)
            current = None
    if current is not None:
        current.update(end_s=horizon_s, duration_s=horizon_s - current["start_s"])
        intervals.append(current)
    reachable = [row for row in samples if row["path"]]
    visible = sum(bool(row["visible_satellite_ids"]) for row in samples)
    count = len(samples)
    availability = len(reachable) / count
    hops = [row["hop_count"] for row in reachable]
    lengths = [row["distance_km"] for row in reachable]
    switches = sum(
        bool(a["path"]) and bool(b["path"]) and a["path"] != b["path"]
        for a, b in zip(samples, samples[1:])
    )
    return {
        "sample_count": count,
        "visible_samples": visible,
        "reachable_samples": len(reachable),
        "coverage": visible / count,
        "availability": availability,
        "target_met": availability >= target,
        "target_margin": availability - target,
        "outage_count": len(intervals),
        "total_outage_s": (count - len(reachable)) * step_s,
        "max_outage_s": max((x["duration_s"] for x in intervals), default=0),
        "outages": intervals,
        "hop_min": min(hops, default=None),
        "hop_max": max(hops, default=None),
        "hop_mean": sum(hops) / len(hops) if hops else None,
        "distance_mean_km": sum(lengths) / len(lengths) if lengths else None,
        "route_switches": switches,
        "reason_samples": dict(Counter(row["reason"] for row in samples)),
    }
