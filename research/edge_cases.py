"""Small preparatory cross-checks; no production implementation."""
import copy
import json
import math
import random
import sys
from pathlib import Path

import numpy as np

from probe import ROOT, geometry, run, bfs


def scalar_snapshot(s, t):
    e = s['environment']
    radius = 6371.0 + e['altitude_km']
    n = math.sqrt(398600.435507 / radius**3)
    inc = math.radians(e['inclination_deg'])
    theta = math.radians(e['earth_angle0_deg']) + 2*math.pi*t/86164.09054
    planes = {p['id']:p for p in s['design']['planes']}
    pos, active, edges = {}, {}, {}
    for sat in s['design']['satellites']:
        plane = planes[sat['plane_id']]
        u = math.radians(sat['slot_deg']+plane['phase_deg']) + n*t
        om = math.radians(plane['raan_deg'])
        x = radius*(math.cos(om)*math.cos(u)-math.sin(om)*math.sin(u)*math.cos(inc))
        y = radius*(math.sin(om)*math.cos(u)+math.cos(om)*math.sin(u)*math.cos(inc))
        z = radius*math.sin(u)*math.sin(inc)
        pos[sat['id']] = (math.cos(theta)*x+math.sin(theta)*y,-math.sin(theta)*x+math.cos(theta)*y,z)
        active[sat['id']] = sat['launch_batch'] <= s['design']['launch_stage'] and not any(f['satellite_id']==sat['id'] and f['start_s']<=t<f['end_s'] for f in s['failures'])
    dot = lambda a,b:sum(x*y for x,y in zip(a,b))
    norm = lambda a:math.sqrt(dot(a,a))
    ids = list(pos)
    for i,a in enumerate(ids):
        for b in ids[i+1:]:
            d = tuple(y-x for x,y in zip(pos[a],pos[b]))
            dd = dot(d,d)
            q = min(1,max(0,-dot(pos[a],d)/dd)) if dd else 0
            near = tuple(x+q*y for x,y in zip(pos[a],d))
            if active[a] and active[b] and norm(d)<e['isl_range_km'] and norm(near)>6371:
                edges[tuple(sorted([a,b]))] = norm(d)
    for g in s['ground_sites']:
        lat,lon = math.radians(g['lat_deg']),math.radians(g['lon_deg'])
        gp = tuple(6371*x for x in (math.cos(lat)*math.cos(lon),math.cos(lat)*math.sin(lon),math.sin(lat)))
        offline = any(f['gateway_id']==g['id'] and f['start_s']<=t<f['end_s'] for f in s['gateway_outages'])
        for sid in ids:
            d = tuple(x-y for x,y in zip(pos[sid],gp))
            el = math.degrees(math.asin(max(-1,min(1,dot(d,gp)/(norm(d)*6371)))))
            if active[sid] and not offline and el>=e['min_elevation_deg']:
                edges[tuple(sorted([sid,g['id']]))] = norm(d)
    return pos,edges


def main():
    base = geometry.load(next((ROOT/'Данные').glob('01*.json')))
    rng = random.Random(2026)
    max_error = 0
    comparisons = 0
    for _ in range(12):
        s = copy.deepcopy(base)
        s['environment'].update(altitude_km=rng.uniform(200,1200), inclination_deg=rng.uniform(0.1,180), earth_angle0_deg=rng.uniform(-720,720), isl_range_km=rng.uniform(1,10000),min_elevation_deg=rng.uniform(0,89))
        s['design']['launch_stage']=rng.randint(1,3)
        for p in s['design']['planes']:
            p.update(raan_deg=rng.uniform(0,360),phase_deg=rng.uniform(0,360))
        for g in s['ground_sites']:
            g.update(lat_deg=rng.uniform(-90,90),lon_deg=rng.uniform(-180,180))
        for t in [0,120,21600,86280,rng.uniform(0,86400)]:
            snap = geometry.snapshot(s,t)
            pos,edges = scalar_snapshot(s,t)
            actual = {tuple(sorted([a,b])):d for a,b,d in snap['edges']}
            assert actual.keys()==edges.keys()
            for sat in snap['satellites']:
                error = max(abs(a-b) for a,b in zip(pos[sat['id']],[sat['x_km'],sat['y_km'],sat['z_km']]))
                max_error=max(max_error,error);assert error<1e-8
            assert all(abs(edges[k]-actual[k])<1e-8 for k in edges)
            comparisons+=1
    checks={'scalar_snapshots_checked':comparisons,'max_position_error_km':max_error}
    short = copy.deepcopy(base);short['environment']['horizon_s']=1200
    a = run(short,True)
    reordered = copy.deepcopy(short)
    for key in ['satellites','planes']:reordered['design'][key].reverse()
    reordered['ground_sites'].reverse()
    b = run(reordered,True)
    assert a['metrics']==b['metrics'];checks['reorder_invariance']=True
    renamed = copy.deepcopy(short)
    mapping = {x['id']:f'node-{i}' for i,x in enumerate(short['design']['satellites']+short['ground_sites'])}
    for x in renamed['design']['satellites']+renamed['ground_sites']:x['id']=mapping[x['id']]
    b = run(renamed,True)
    assert all(a['metrics'][c]['reachable_samples']==b['metrics'][mapping[c]]['reachable_samples'] for c in a['metrics'])
    checks['renamed_ids_preserve_reachability']=True
    # Arbitrary small valid scenario: a coincident pair, one client, two gateways.
    tiny = copy.deepcopy(base)
    tiny['environment'].update(horizon_s=360,step_s=120,earth_angle0_deg=0,min_elevation_deg=0)
    tiny['design']['satellites']=tiny['design']['satellites'][:2]
    tiny['design']['satellites'][1]['slot_deg']=0
    tiny['ground_sites']=[{'id':'user-site','name':'User','role':'client','lat_deg':0,'lon_deg':0},
                          {'id':'exit-A','name':'A','role':'gateway','lat_deg':0,'lon_deg':0},
                          {'id':'exit-B','name':'B','role':'gateway','lat_deg':0,'lon_deg':0}]
    tiny['gateway_outages']=[{'gateway_id':'exit-A','start_s':0,'end_s':360}]
    rr=run(tiny,True)
    assert all(row['path'][-1]=='exit-B' for row in rr['rows']['user-site'])
    checks['second_gateway_used_when_first_offline']=True
    tiny['gateway_outages'].append({'gateway_id':'exit-B','start_s':0,'end_s':360})
    rr=run(tiny,True)
    assert rr['metrics']['user-site']['max_outage_s']==360
    assert rr['metrics']['user-site']['reason_samples']=={'all_gateways_offline':3}
    checks['all_gateways_offline_full_horizon_outage']=True
    tiny['gateway_outages']=[]
    tiny['failures']=[{'satellite_id':sat['id'],'start_s':61,'end_s':181} for sat in tiny['design']['satellites']]
    rr=run(tiny,True)
    assert [bool(row['path']) for row in rr['rows']['user-site']]==[True,False,True]
    checks['off_grid_failure_sample_semantics']=True
    tiny['failures']+=copy.deepcopy(tiny['failures'])
    assert run(tiny,True)['metrics']==rr['metrics'];checks['overlap_union_semantics']=True
    snap=geometry.snapshot(base,0)
    threshold=next(d for a,b,d in snap['edges'] if [a,b]==['S01','S02'])
    s=copy.deepcopy(base);s['environment']['isl_range_km']=threshold
    assert not any([a,b]==['S01','S02'] for a,b,_ in geometry.snapshot(s,0)['edges'])
    s['environment']['isl_range_km']=float(np.nextafter(threshold,float('inf')))
    assert any([a,b]==['S01','S02'] for a,b,_ in geometry.snapshot(s,0)['edges'])
    checks['isl_strict_threshold']=True
    client,sid,el=next((c,sid,el) for c,v in snap['elevation_deg'].items() for sid,el in v.items() if 0<el<90)
    s=copy.deepcopy(base);s['environment']['min_elevation_deg']=el
    assert any(a==client and b==sid for a,b,_ in geometry.snapshot(s,0)['edges'])
    s['environment']['min_elevation_deg']=float(np.nextafter(el,float('inf')))
    assert not any(a==client and b==sid for a,b,_ in geometry.snapshot(s,0)['edges'])
    checks['elevation_inclusive_threshold']=True
    s=copy.deepcopy(base);s['design']['launch_stage']=2
    rr=run(s,True)
    checks['stage_2_metrics']={c:{k:m[k] for k in ['coverage_pct','availability_pct','max_outage_s']} for c,m in rr['metrics'].items()}
    (ROOT/'research'/'edge-findings.json').write_text(json.dumps(checks,indent=2),encoding='utf-8')
    print(json.dumps(checks,indent=2))


if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
