import argparse
import json
from pathlib import Path
import sys

from .engine import export_result, simulate
from .scenario import ScenarioError, load_scenario


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Расчёт геометрической доступности группировки"
    )
    parser.add_argument("scenario", type=Path)
    parser.add_argument(
        "--output", "-o", type=Path, help="Результат cosmo-A-result-1.0"
    )
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    try:
        scenario = load_scenario(args.scenario)
        if args.validate_only:
            print("Сценарий корректен")
            return 0
        result = simulate(scenario)
        text = json.dumps(
            export_result(result), ensure_ascii=False, allow_nan=False, indent=2
        )
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            temporary = args.output.with_suffix(args.output.suffix + ".tmp")
            temporary.write_text(text, encoding="utf-8")
            temporary.replace(args.output)
            print(json.dumps(result["summary"], ensure_ascii=False, indent=2))
        else:
            print(text)
        return 0
    except (ScenarioError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
