"""Schema checks complement (and never replace) the organizer's validator.

Validation returns a copy of the original document, preserving extra fields and
numeric representation. Pydantic's parsed instance is used only for checking.
"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .geometry_adapter import reference

Number = Annotated[float, Field(strict=True, allow_inf_nan=False)]
Identifier = Annotated[str, Field(strict=True, min_length=1)]
Integer = Annotated[int, Field(strict=True)]


class Document(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)


class Meta(Document):
    id: Identifier
    title: Annotated[str, Field(min_length=1)]


class Environment(Document):
    altitude_km: Annotated[Number, Field(ge=200, le=1200)]
    inclination_deg: Annotated[Number, Field(gt=0, le=180)]
    earth_angle0_deg: Number
    horizon_s: Annotated[Integer, Field(gt=0, le=172800)]
    step_s: Annotated[Integer, Field(gt=0)]
    min_elevation_deg: Annotated[Number, Field(ge=0, lt=90)]
    isl_range_km: Annotated[Number, Field(gt=0, le=10000)]
    target_availability: Annotated[Number, Field(ge=0, le=1)]


class Plane(Document):
    id: Identifier
    raan_deg: Annotated[Number, Field(ge=0, lt=360)]
    phase_deg: Annotated[Number, Field(ge=0, lt=360)]


class Satellite(Document):
    id: Identifier
    plane_id: Identifier
    slot_deg: Number
    launch_batch: Annotated[Number, Field(ge=1, le=3)]

    @field_validator("launch_batch")
    @classmethod
    def launch_number(cls, value):
        if value not in (1, 2, 3):
            raise ValueError("Очередь запуска должна быть 1, 2 или 3")
        return value


class Design(Document):
    launch_stage: Annotated[Integer, Field(ge=1, le=3)]
    planes: Annotated[list[Plane], Field(min_length=1)]
    satellites: Annotated[list[Satellite], Field(min_length=1)]


class GroundSite(Document):
    id: Identifier
    name: str
    role: Literal["client", "gateway"]
    lat_deg: Annotated[Number, Field(ge=-90, le=90)]
    lon_deg: Annotated[Number, Field(ge=-180, le=180)]


class Failure(Document):
    satellite_id: Identifier
    start_s: Number
    end_s: Number


class GatewayOutage(Document):
    gateway_id: Identifier
    start_s: Number
    end_s: Number


class Scenario(Document):
    schema_version: Literal["cosmo-A-1.0"]
    meta: Meta
    environment: Environment
    design: Design
    ground_sites: list[GroundSite]
    failures: list[Failure]
    gateway_outages: list[GatewayOutage]


class ScenarioError(ValueError):
    def __init__(self, issues: list[dict]):
        self.issues = issues
        super().__init__("; ".join(f"{e['path']}: {e['message']}" for e in issues))


def field_path(parts) -> str:
    result = ""
    for part in parts:
        result += (
            f"[{part}]"
            if isinstance(part, int)
            else ("." if result else "") + str(part)
        )
    return result or "$"


def parse_json(text: str | bytes) -> dict:
    def integer(raw):
        if len(raw.lstrip("-")) > 309:
            raise ScenarioError(
                [
                    {
                        "path": "$",
                        "message": "Число превышает конечный числовой диапазон модели",
                        "code": "non_finite",
                    }
                ]
            )
        return int(raw)

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ScenarioError(
                    [
                        {
                            "path": key,
                            "message": "Повторяющийся ключ JSON",
                            "code": "duplicate_key",
                        }
                    ]
                )
            result[key] = value
        return result

    def constant(value):
        raise ScenarioError(
            [
                {
                    "path": "$",
                    "message": f"Недопустимое число {value}",
                    "code": "non_finite",
                }
            ]
        )

    try:
        if isinstance(text, bytes):
            text = text.decode("utf-8-sig")
        parsed = json.loads(
            text, object_pairs_hook=pairs, parse_constant=constant, parse_int=integer
        )
        pending = [(parsed, 0)]
        while pending:
            node, depth = pending.pop()
            if depth > 128:
                raise ScenarioError(
                    [
                        {
                            "path": "$",
                            "message": "Вложенность JSON превышает 128 уровней",
                            "code": "document_depth",
                        }
                    ]
                )
            if isinstance(node, dict):
                pending.extend((v, depth + 1) for v in node.values())
            elif isinstance(node, list):
                pending.extend((v, depth + 1) for v in node)
        return parsed
    except ScenarioError:
        raise
    except (ValueError, RecursionError, UnicodeDecodeError) as exc:
        raise ScenarioError(
            [
                {
                    "path": "$",
                    "message": f"Некорректный UTF-8 JSON: {exc}",
                    "code": "invalid_json",
                }
            ]
        ) from exc


def validate_scenario(value: dict) -> dict:
    try:
        Scenario.model_validate(value)
    except ValidationError as exc:
        messages = {
            "missing": "Обязательное поле отсутствует",
            "int_type": "Нужно целое число, не строка и не bool",
            "float_type": "Нужно число, не строка и не bool",
            "finite_number": "Число должно быть конечным",
            "string_type": "Нужна строка",
            "list_type": "Нужен список",
            "literal_error": "Недопустимое значение",
            "model_type": "Нужен объект JSON",
        }
        raise ScenarioError(
            [
                {
                    "path": field_path(e["loc"]),
                    "message": messages.get(e["type"], e["msg"]),
                    "code": e["type"],
                }
                for e in exc.errors(include_url=False)
            ]
        ) from exc
    issues = []

    def issue(path, message, code="invalid_reference"):
        issues.append({"path": path, "message": message, "code": code})

    def finite_tree(node, path="$"):
        if isinstance(node, float) and not math.isfinite(node):
            issue(path, "Число должно быть конечным", "non_finite")
        elif isinstance(node, dict):
            for k, v in node.items():
                finite_tree(v, f"{path}.{k}")
        elif isinstance(node, list):
            for i, v in enumerate(node):
                finite_tree(v, f"{path}[{i}]")

    finite_tree(value)
    env, design = value["environment"], value["design"]
    if env["step_s"] > env["horizon_s"] or env["horizon_s"] % env["step_s"]:
        issue(
            "environment.step_s",
            "Шаг не должен превышать горизонт; горизонт должен быть кратен шагу",
            "time_grid",
        )

    def unique(items, path):
        seen = set()
        for i, item in enumerate(items):
            if item["id"] in seen:
                issue(
                    f"{path}[{i}].id",
                    f"Идентификатор {item['id']} повторяется",
                    "duplicate_id",
                )
            seen.add(item["id"])
        return seen

    planes = unique(design["planes"], "design.planes")
    sats = unique(design["satellites"], "design.satellites")
    unique(value["ground_sites"], "ground_sites")
    for i, sat in enumerate(design["satellites"]):
        if sat["plane_id"] not in planes:
            issue(
                f"design.satellites[{i}].plane_id",
                f"Плоскость {sat['plane_id']} не найдена",
            )
    gateways = {g["id"] for g in value["ground_sites"] if g["role"] == "gateway"}
    for role in ("client", "gateway"):
        if not any(g["role"] == role for g in value["ground_sites"]):
            issue(
                "ground_sites",
                f"Нужен хотя бы один пункт с role={role}",
                "missing_role",
            )
    for i, ground in enumerate(value["ground_sites"]):
        if ground["id"] in sats:
            issue(
                f"ground_sites[{i}].id",
                "ID наземного пункта совпадает с ID спутника",
                "duplicate_id",
            )
    for field, key, valid in (
        ("failures", "satellite_id", sats),
        ("gateway_outages", "gateway_id", gateways),
    ):
        for i, outage in enumerate(value[field]):
            if outage[key] not in valid:
                issue(f"{field}[{i}].{key}", f"Объект {outage[key]} не найден")
            if not 0 <= outage["start_s"] < outage["end_s"] <= env["horizon_s"]:
                issue(
                    f"{field}[{i}]",
                    "Нужно 0 ≤ start_s < end_s ≤ horizon_s",
                    "outage_interval",
                )
    if issues:
        raise ScenarioError(issues)
    reference().validate(value)
    return deepcopy(value)


def load_scenario(path: str | Path) -> dict:
    return validate_scenario(parse_json(Path(path).read_bytes()))


def canonical_hash(scenario: dict) -> str:
    payload = json.dumps(
        scenario,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
