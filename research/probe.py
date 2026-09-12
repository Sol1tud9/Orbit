"""Preparatory experiments only; organizer geometry is imported unchanged.

Run from any directory with Python 3.10+ and NumPy. Writes findings.json here.
No production API, UI, or application implementation is included.
"""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import math
from collections import Counter, deque
from pathlib import Path
from time import perf_counter

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("organizer_geometry", ROOT / "Расчетный модуль" / "geometry.py")
geometry = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(geometry)


def bfs(adj, client, satellites, gateways, allow_ground_relay=False):
    queue = deque([client])
    prev = {client: None}
    while queue:
        node = queue.popleft()
        if node in gateways:
            path = [node]
            while prev[path[-1]] is not None:
                path.append(prev[path[-1]])
            return path[::-1]
        for nxt in sorted(adj[node]):
            if nxt not in prev and (allow_ground_relay or nxt in satellites or nxt in gateways):
                prev[nxt] = node
                queue.append(nxt)
    return []


def run(s, verify=False):
    geometry.validate(s)
    started = perf_counter()
    sats = {v['id'] for v in s['design']['satellites']}
    clients = [g['id'] for g in s['ground_sites'] if g['role'] == 'client']
    gateways = {g['id'] for g in s['ground_sites'] if g['role'] == 'gateway'}
    all_ids = sorted(sats | set(clients) | gateways)
    rows = {c: [] for c in clients}
    snapshots = []
    false_positive_ground_relay = Counter()
    grid = range(0, s['environment']['horizon_s'], s['environment']['step_s'])
    for t in grid:
        snap = geometry.snapshot(s, t)
        adj = {node: {} for node in all_ids}
        for a, b, distance in snap['edges']:
            adj[a][b] = adj[b][a] = distance
        online = {g for g in gateways if not any(o['gateway_id'] == g and o['start_s'] <= t < o['end_s'] for o in s['gateway_outages'])}
        # Independent all-pairs oracle: only satellites are admissible intermediates.
        if verify:
            idx = {node: i for i, node in enumerate(all_ids)}
            d = np.full((len(all_ids), len(all_ids)), 10**6, dtype=np.int32)
            np.fill_diagonal(d, 0)
            for a, b, _ in snap['edges']:
                d[idx[a], idx[b]] = d[idx[b], idx[a]] = 1
            for sat in sorted(sats):
                k = idx[sat]
                d = np.minimum(d, d[:, k, None] + d[None, k, :])
        active = {v['id'] for v in snap['satellites'] if v['active']}
        components, pending = [], set(active)
        while pending:
            found = {pending.pop()}
            q = list(found)
            while q:
                a = q.pop()
                for b in adj[a]:
                    if b in pending:
                        pending.remove(b)
                        found.add(b)
                        q.append(b)
            components.append(found)
        snapshots.append({'t_s': t, 'active': len(active), 'isl_edges': sum(a in sats and b in sats for a,b,_ in snap['edges']), 'satellite_components': len(components), 'gateway_contact': any(adj[g] for g in gateways)})
        for client in clients:
            path = bfs(adj, client, sats, online)
            if verify:
                expected = min((int(d[idx[client], idx[g]]) for g in online), default=10**6)
                assert (len(path)-1 if path else 10**6) == expected, (t,client,path,expected)
                assert not path or (path[0] == client and path[-1] in online and all(x in active for x in path[1:-1]))
                assert all(b in adj[a] for a,b in zip(path,path[1:]))
                assert len(path) == len(set(path))
            if not path and bfs(adj, client, sats, online, True):
                false_positive_ground_relay[client] += 1
            reason = ('connected' if path else 'no_client_coverage' if not adj[client]
                      else 'all_gateways_offline' if not online else 'no_gateway_contact'
                      if not any(adj[g] for g in online) else 'isl_disconnected')
            rows[client].append({'t_s':t, 'visible':bool(adj[client]), 'path':path, 'reason':reason,
                                 'distance_km':sum(adj[a][b] for a,b in zip(path,path[1:])) if path else None})
    metrics = {}
    step = s['environment']['step_s']
    for client, rr in rows.items():
        intervals = []
        begin = None
        for row in rr:
            if not row['path'] and begin is None:
                begin = row['t_s']
            if row['path'] and begin is not None:
                intervals.append([begin,row['t_s']]); begin = None
        if begin is not None:
            intervals.append([begin,s['environment']['horizon_s']])
        hops = [len(x['path'])-1 for x in rr if x['path']]
        metrics[client] = {'visible_samples':sum(x['visible'] for x in rr), 'reachable_samples':len(hops),
            'coverage_pct':100*sum(x['visible'] for x in rr)/len(rr), 'availability_pct':100*len(hops)/len(rr),
            'max_outage_s':max((b-a for a,b in intervals),default=0), 'outage_count':len(intervals),
            'outage_intervals_s':intervals, 'reason_samples':dict(Counter(x['reason'] for x in rr)),
            'hop_min':min(hops,default=None), 'hop_max':max(hops,default=None),
            'hop_mean':sum(hops)/len(hops) if hops else None,
            'invalid_ground_relay_false_positives':false_positive_ground_relay[client]}
    return {'samples':len(grid), 'elapsed_s':perf_counter()-started, 'metrics':metrics,
            'snapshot_summary':snapshots, 'rows':rows}


def main():
    output = {'note':'Independent diagnostic BFS and satellite-only Floyd-Warshall; not organizer-supplied answer keys.',
              'geometry_sha256':hashlib.sha256((ROOT/'Расчетный модуль'/'geometry.py').read_bytes()).hexdigest(),
              'numpy_version':np.__version__, 'scenarios':{}}
    runs = {}
    paths = sorted((ROOT/'Данные').glob('*.json'))
    for p in paths:
        s = geometry.load(p)
        result = run(s,verify=True)
        runs[p.stem] = result
        output['scenarios'][p.stem] = {k:v for k,v in result.items() if k != 'rows'}
        output['scenarios'][p.stem]['source_sha256'] = hashlib.sha256(p.read_bytes()).hexdigest()
        print(p.stem, json.dumps({'elapsed_s':result['elapsed_s'],'metrics':{c:{k:v for k,v in m.items() if k != 'outage_intervals_s'} for c,m in result['metrics'].items()}},ensure_ascii=False))
    base_s = geometry.load(paths[0])
    base = runs[paths[0].stem]
    # Controlled monotonicity and matching-prefix checks on every sample.
    checks = {}
    for name, result in runs.items():
        checks[name+'_reachability_subset_of_full'] = all(not r['path'] or b['path'] for c,rr in result['rows'].items() for r,b in zip(rr,base['rows'][c]))
    failed = runs[paths[2].stem]
    checks['outages_prefix_identical_before_21600'] = all(r == b for c,rr in failed['rows'].items() for r,b in zip(rr[:180],base['rows'][c][:180]))
    checks['range_change_preserves_coverage'] = all(r['visible'] == b['visible'] for c,rr in runs[paths[3].stem]['rows'].items() for r,b in zip(rr,base['rows'][c]))
    output['checks'] = checks
    assert all(checks.values())
    # Exact failure endpoints, output shape, and the fact that snapshot skips validation.
    fs = geometry.load(paths[2])
    output['failure_boundary_active_counts'] = {str(t):sum(v['active'] for v in geometry.snapshot(fs,t)['satellites']) for t in [21599.999,21600,86399.999,86400]}
    snap0 = geometry.snapshot(base_s,0)
    output['snapshot_example'] = {'keys':list(snap0), 'satellite':snap0['satellites'][0], 'edge':snap0['edges'][0],
                                  'elevation_example':{k:list(v.items())[:2] for k,v in snap0['elevation_deg'].items()}}
    output['validation_probes'] = {}
    mutations = {
        'launch_stage_boolean':lambda s:s['design'].__setitem__('launch_stage',True),
        'launch_batch_boolean':lambda s:s['design']['satellites'][0].__setitem__('launch_batch',True),
        'launch_batch_float':lambda s:s['design']['satellites'][0].__setitem__('launch_batch',1.0),
        'missing_meta':lambda s:s.pop('meta'),
        'missing_environment_field':lambda s:s['environment'].pop('altitude_km'),
        'large_slot_angle':lambda s:s['design']['satellites'][0].__setitem__('slot_deg',-720.5),
        'nonfinite_altitude':lambda s:s['environment'].__setitem__('altitude_km',float('nan')),
        'duplicate_satellite_id':lambda s:s['design']['satellites'][1].__setitem__('id',s['design']['satellites'][0]['id']),
    }
    for name,mut in mutations.items():
        s = copy.deepcopy(base_s);mut(s)
        try:
            geometry.validate(s); verdict='accepted'
        except Exception as e:
            verdict=f'{type(e).__name__}: {e}'
        output['validation_probes'][name]=verdict
    # Timing excludes the independent oracle and repeated routing to measure native geometry.
    start = perf_counter()
    for t in range(0,86400,120): geometry.snapshot(base_s,t)
    output['full_day_geometry_only_s'] = perf_counter()-start
    output['same_plane_adjacent_distance_km'] = 2*(geometry.R+base_s['environment']['altitude_km'])*math.sin(math.radians(22.5)/2)
    (ROOT/'research'/'findings.json').write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in output.items() if k!='scenarios'},ensure_ascii=False,indent=2))


if __name__ == '__main__':
    import sys
    sys.stdout.reconfigure(encoding='utf-8')
    main()
