from copy import deepcopy
import json

import pytest

from orbita.scenario import ScenarioError, canonical_hash, parse_json, validate_scenario


@pytest.mark.parametrize(
    "field,value",
    [
        ("altitude_km", 199),
        ("altitude_km", 1201),
        ("altitude_km", True),
        ("inclination_deg", 0),
        ("inclination_deg", 181),
        ("horizon_s", 172801),
        ("horizon_s", 360.0),
        ("step_s", 0),
        ("step_s", 121),
        ("step_s", True),
        ("min_elevation_deg", 90),
        ("isl_range_km", 0),
        ("isl_range_km", 10001),
        ("target_availability", 1.1),
        ("earth_angle0_deg", float("inf")),
    ],
)
def test_environment_constraints(scenario, field, value):
    scenario["environment"][field] = value
    with pytest.raises(ScenarioError) as error:
        validate_scenario(scenario)
    assert any("environment" in e["path"] for e in error.value.issues)


@pytest.mark.parametrize("field", ["launch_stage", "launch_batch"])
def test_boolean_is_not_a_launch_number(scenario, field):
    target = (
        scenario["design"]
        if field == "launch_stage"
        else scenario["design"]["satellites"][0]
    )
    target[field] = True
    with pytest.raises(ScenarioError):
        validate_scenario(scenario)


def test_references_and_duplicate_ids_have_paths(scenario):
    scenario["design"]["satellites"][1]["id"] = "S01"
    scenario["design"]["satellites"][2]["plane_id"] = "missing"
    scenario["failures"] = [{"satellite_id": "unknown", "start_s": 0, "end_s": 1}]
    with pytest.raises(ScenarioError) as error:
        validate_scenario(scenario)
    assert {x["path"] for x in error.value.issues} >= {
        "design.satellites[1].id",
        "design.satellites[2].plane_id",
        "failures[0].satellite_id",
    }


@pytest.mark.parametrize(
    "payload", ['{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}', '{"a":', b"\xff"]
)
def test_json_errors(payload):
    with pytest.raises(ScenarioError):
        parse_json(payload)


def test_oversized_numeric_literal_and_deep_json_are_user_errors():
    for payload in ['{"number":' + "1" * 5000 + "}", "[" * 2000 + "0" + "]" * 2000]:
        with pytest.raises(ScenarioError):
            parse_json(payload)


@pytest.mark.parametrize("payload", [None, [], 1, "scenario"])
def test_root_must_be_object(payload):
    with pytest.raises(ScenarioError):
        validate_scenario(payload)


def test_missing_metadata_is_reported(scenario):
    del scenario["meta"]
    with pytest.raises(ScenarioError) as error:
        validate_scenario(scenario)
    assert error.value.issues[0]["path"] == "meta"


def test_integral_launch_batch_float_matches_reference(scenario):
    scenario["design"]["satellites"][0]["launch_batch"] = 1.0
    assert validate_scenario(scenario) == scenario
    scenario["design"]["satellites"][0]["launch_batch"] = 1.5
    with pytest.raises(ScenarioError):
        validate_scenario(scenario)


def test_preserve_extensions_numeric_values_and_unrestricted_slot(scenario):
    scenario["notes"] = {"source": "jury", "number": 3}
    scenario["design"]["satellites"][0]["slot_deg"] = -720.5
    scenario["environment"]["earth_angle0_deg"] = 1000
    original = deepcopy(scenario)
    parsed = validate_scenario(parse_json(json.dumps(scenario)))
    assert parsed == original
    parsed["notes"]["number"] = 4
    assert scenario == original
    assert canonical_hash(scenario) == canonical_hash(
        dict(reversed(list(scenario.items())))
    )
