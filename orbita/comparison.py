def scenario_diff(a, b, path=""):
    if isinstance(a, dict) and isinstance(b, dict):
        rows = []
        for key in sorted(a.keys() | b.keys()):
            child = f"{path}.{key}" if path else key
            if key not in a or key not in b:
                rows.append({"path": child, "before": a.get(key), "after": b.get(key)})
            else:
                rows.extend(scenario_diff(a[key], b[key], child))
        return rows
    if isinstance(a, list) and isinstance(b, list):
        if all(isinstance(x, dict) and "id" in x for x in a + b):
            return scenario_diff({x["id"]: x for x in a}, {x["id"]: x for x in b}, path)
        rows = []
        for i in range(max(len(a), len(b))):
            if i >= len(a) or i >= len(b):
                rows.append(
                    {
                        "path": f"{path}[{i}]",
                        "before": a[i] if i < len(a) else None,
                        "after": b[i] if i < len(b) else None,
                    }
                )
            else:
                rows.extend(scenario_diff(a[i], b[i], f"{path}[{i}]"))
        return rows
    return [] if a == b else [{"path": path, "before": a, "after": b}]


def compare_results(a, b):
    left, right = a["effective_scenario"], b["effective_scenario"]
    issues = []
    for key in ("geometry_sha256", "routing_policy"):
        if a.get("provenance", {}).get(key) != b.get("provenance", {}).get(key):
            issues.append(
                "Различаются версии геометрии или политики маршрутизации: нужен общий пересчёт"
            )
    for key in ("horizon_s", "step_s"):
        if left["environment"][key] != right["environment"][key]:
            issues.append(f"Различается {key}: нужен пересчёт на общей временной сетке")

    def clients(scenario):
        return {
            g["id"]: (g["lat_deg"], g["lon_deg"])
            for g in scenario["ground_sites"]
            if g["role"] == "client"
        }

    if clients(left) != clients(right):
        issues.append("Различаются клиентские пункты или их координаты")
    rows = []
    if not issues:
        for client in a["series"]:
            am, bm = a["summary"]["clients"][client], b["summary"]["clients"][client]
            gained = lost = 0
            transitions = []
            for ar, br in zip(a["series"][client], b["series"][client]):
                before, after = bool(ar["path"]), bool(br["path"])
                gained += not before and after
                lost += before and not after
                value = (
                    "gained"
                    if after and not before
                    else "lost"
                    if before and not after
                    else "unchanged"
                )
                transitions.append(value)
            rows.append(
                {
                    "client_id": client,
                    "a": am,
                    "b": bm,
                    "availability_delta": bm["availability"] - am["availability"],
                    "max_outage_delta_s": bm["max_outage_s"] - am["max_outage_s"],
                    "gained_samples": gained,
                    "lost_samples": lost,
                    "transitions": transitions,
                }
            )
    return {
        "compatible": not issues,
        "issues": issues,
        "diff": scenario_diff(left, right),
        "clients": rows,
    }
