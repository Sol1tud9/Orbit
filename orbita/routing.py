"""Minimum hops, then distance, then lexical path, with satellite-only transit."""

from collections import deque

from .topology import Topology

ROUTING_POLICY = "min-hops-distance-lex-v1"


def route(topology: Topology, client_id: str) -> dict:
    adj = topology.adjacency
    allowed = topology.satellites | topology.online_gateways
    depth = {client_id: 0}
    queue = deque([client_id])
    order = []
    while queue:
        node = queue.popleft()
        order.append(node)
        if node in topology.online_gateways:
            continue  # A gateway is a destination, never a relay.
        for neighbor in sorted(adj[node]):
            if neighbor in allowed and neighbor not in depth:
                depth[neighbor] = depth[node] + 1
                queue.append(neighbor)

    # Edges between successive BFS layers form a DAG. Optimize the secondary
    # distance criterion within that DAG, without sacrificing minimum hops.
    best = {client_id: (0.0, (client_id,))}
    for node in order:
        if node not in best or node in topology.online_gateways:
            continue
        distance, path = best[node]
        for neighbor, length in adj[node].items():
            if neighbor in allowed and depth.get(neighbor) == depth[node] + 1:
                candidate = (distance + length, path + (neighbor,))
                if neighbor not in best or candidate < best[neighbor]:
                    best[neighbor] = candidate
    candidates = [(depth[g], *best[g]) for g in topology.online_gateways if g in best]
    if not candidates:
        return {"path": [], "hop_count": None, "distance_km": None, "gateway_id": None}
    hops, distance, path = min(candidates)
    return {
        "path": list(path),
        "hop_count": hops,
        "distance_km": distance,
        "gateway_id": path[-1],
    }


def explain(topology: Topology, client_id: str, path: list[str]) -> dict:
    visible = sorted(topology.adjacency[client_id])
    gateway_contacts = {
        g: sorted(topology.adjacency[g]) for g in sorted(topology.online_gateways)
    }
    client_components = sorted({topology.component_of[s] for s in visible})
    exit_components = sorted(
        {topology.component_of[s] for nodes in gateway_contacts.values() for s in nodes}
    )
    facts = {
        "client_has_coverage": bool(visible),
        "any_gateway_online": bool(topology.online_gateways),
        "any_gateway_contact": any(gateway_contacts.values()),
        "client_component_ids": client_components,
        "gateway_component_ids": exit_components,
        "gateway_contacts": gateway_contacts,
    }
    reason = (
        "connected"
        if path
        else "no_client_coverage"
        if not visible
        else "all_gateways_offline"
        if not topology.online_gateways
        else "no_gateway_contact"
        if not facts["any_gateway_contact"]
        else "isl_disconnected"
    )
    return {"visible_satellite_ids": visible, "reason": reason, "facts": facts}
