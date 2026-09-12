from hypothesis import given, strategies as st

from orbita.analysis import summarize


def rows(flags):
    return [
        {
            "t_s": i * 120,
            "path": ["c", "s", "g"] if flag else [],
            "visible_satellite_ids": ["s"],
            "reason": "connected"
            if flag
            else ("isl_disconnected" if i % 2 else "no_gateway_contact"),
            "hop_count": 2 if flag else None,
            "distance_km": 1000 if flag else None,
        }
        for i, flag in enumerate(flags)
    ]


@given(st.lists(st.booleans(), min_size=1, max_size=300))
def test_sample_metrics_against_independent_boolean_runs(flags):
    m = summarize(rows(flags), 120, len(flags) * 120, 0.9)
    lengths = [
        len(chunk)
        for chunk in "".join("1" if f else "0" for f in flags).split("1")
        if chunk
    ]
    assert m["max_outage_s"] == max(lengths, default=0) * 120
    assert m["outage_count"] == len(lengths)
    assert m["total_outage_s"] == flags.count(False) * 120
    assert m["availability"] == sum(flags) / len(flags)
    assert m["hop_mean"] == (2 if any(flags) else None)


def test_endpoints_are_separate_and_reason_change_does_not_split():
    m = summarize(rows([False, False, True, False, False]), 120, 600, 0.9)
    assert m["max_outage_s"] == 240
    assert [(o["start_s"], o["end_s"]) for o in m["outages"]] == [(0, 240), (360, 600)]
