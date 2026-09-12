from itertools import combinations
import random

import numpy as np
import pytest

from orbita.routing import route
from orbita.topology import Topology


def graph(edges, sats=("s1", "s2", "s3"), gateways=("g",), extra=()):
    adj = {n: {} for n in ["c", *sats, *gateways, *extra]}
    for a, b, w in edges:
        adj[a][b] = adj[b][a] = w
    return Topology(adj, set(sats), set(gateways), [], {})


def exhaustive(topology):
    found = []

    def visit(path, distance):
        node = path[-1]
        if node in topology.online_gateways:
            found.append((len(path) - 1, distance, tuple(path)))
            return
        for nxt, length in topology.adjacency[node].items():
            if (
                nxt not in path
                and nxt in topology.satellites | topology.online_gateways
            ):
                visit([*path, nxt], distance + length)

    visit(["c"], 0)
    return min(found) if found else None


def test_ground_relay_is_forbidden():
    t = graph(
        [
            ("c", "s1", 1),
            ("s1", "another-client", 1),
            ("another-client", "s2", 1),
            ("s2", "g", 1),
        ],
        extra=("another-client",),
    )
    assert route(t, "c")["path"] == []


def test_hops_then_distance_then_lexical():
    t = graph(
        [
            ("c", "s1", 10),
            ("s1", "g", 10),
            ("c", "s2", 1),
            ("s2", "s3", 1),
            ("s3", "g", 1),
        ]
    )
    assert route(t, "c")["path"] == ["c", "s1", "g"]
    t.adjacency["s2"]["g"] = t.adjacency["g"]["s2"] = 4
    assert route(t, "c")["path"] == ["c", "s2", "g"]
    t.adjacency["c"]["s1"] = t.adjacency["s1"]["c"] = 1
    t.adjacency["s1"]["g"] = t.adjacency["g"]["s1"] = 4
    assert route(t, "c")["path"] == ["c", "s1", "g"]


@pytest.mark.parametrize("seed", range(40))
def test_random_graphs_match_exhaustive_search(seed):
    rng = random.Random(seed)
    nodes = ["c", "s1", "s2", "s3", "s4", "g", "g2", "other-client"]
    edges = [
        (a, b, rng.randint(0, 100))
        for a, b in combinations(nodes, 2)
        if rng.random() < 0.38 and not (a.startswith("g") and b.startswith("g"))
    ]
    t = graph(
        edges,
        sats=("s1", "s2", "s3", "s4"),
        gateways=("g", "g2"),
        extra=("other-client",),
    )
    actual, expected = route(t, "c"), exhaustive(t)
    assert (
        (actual["hop_count"], actual["distance_km"], tuple(actual["path"]))
        if actual["path"]
        else None
    ) == expected


def floyd_hops(scenario, snapshot):
    ids = sorted(
        [x["id"] for x in scenario["design"]["satellites"]]
        + [g["id"] for g in scenario["ground_sites"]]
    )
    idx = {v: i for i, v in enumerate(ids)}
    distance = np.full((len(ids), len(ids)), 100000, dtype=np.int32)
    np.fill_diagonal(distance, 0)
    for a, b, _ in snapshot["edges"]:
        distance[idx[a], idx[b]] = distance[idx[b], idx[a]] = 1
    for sat in scenario["design"]["satellites"]:
        k = idx[sat["id"]]
        distance = np.minimum(distance, distance[:, k, None] + distance[None, k, :])
    return idx, distance
