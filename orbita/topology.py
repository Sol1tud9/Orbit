from dataclasses import dataclass


@dataclass
class Topology:
    adjacency: dict[str, dict[str, float]]
    satellites: set[str]
    online_gateways: set[str]
    components: list[list[str]]
    component_of: dict[str, int]


def build_topology(scenario: dict, snap: dict) -> Topology:
    active = {sat["id"] for sat in snap["satellites"] if sat["active"]}
    adjacency = {sat["id"]: {} for sat in snap["satellites"]}
    adjacency.update({g["id"]: {} for g in scenario["ground_sites"]})
    for a, b, distance in snap["edges"]:
        adjacency[a][b] = adjacency[b][a] = distance
    t_s = snap["t_s"]
    offline = {
        o["gateway_id"]
        for o in scenario["gateway_outages"]
        if o["start_s"] <= t_s < o["end_s"]
    }
    online = {
        g["id"] for g in scenario["ground_sites"] if g["role"] == "gateway"
    } - offline
    remaining, components, component_of = set(active), [], {}
    while remaining:
        root = min(remaining)
        remaining.remove(root)
        found, stack = [root], [root]
        while stack:
            node = stack.pop()
            for neighbor in adjacency[node]:
                if neighbor in remaining:
                    remaining.remove(neighbor)
                    found.append(neighbor)
                    stack.append(neighbor)
        component = sorted(found)
        for node in component:
            component_of[node] = len(components)
        components.append(component)
    return Topology(adjacency, active, online, components, component_of)
