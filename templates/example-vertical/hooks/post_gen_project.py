#!/usr/bin/env python3
"""Post-generation hook: print next-step guidance."""

from __future__ import annotations

SLUG = "{{ cookiecutter.vertical_slug }}"
NAME = "{{ cookiecutter.vertical_name }}"


def main() -> None:
    print("")
    print(f"  Generated vertical: {NAME} ({SLUG})")
    print("")
    print("  Next steps:")
    print(f"    1. cd examples/{SLUG}")
    print(f"    2. python data/generators/generate_seed.py --days 1 --seed 42")
    print(f"    3. bash ../../scripts/lint-vertical.sh examples/{SLUG}")
    print(f"    4. cd domains/dbt && dbt deps && dbt parse")
    print("")
    print(f"  Edit contracts/{SLUG}-primary.yaml to describe your data product.")
    print("")


if __name__ == "__main__":
    main()
