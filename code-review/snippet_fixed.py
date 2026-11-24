"""
select_for_operator: picks the radar items an operator should see.

An item is shown if
  1. its jurisdiction is "EU" or the operator's country, and
  2. it concerns the operator's sector: one of its NACE tags equals one of the
     operator's codes, or is a broader or narrower code in the same branch
     (an item tagged "C24" concerns an operator on "C24.4", and vice versa).
     Items without any NACE tag are horizontal rules (late payments, SME
     reporting, ...) and concern every sector, so they are always shown.

Result is sorted by deadline, soonest first; items without a deadline last.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date


@dataclass
class Item:
    id: str
    jurisdiction: str
    title: str
    nace_tags: list[str] = field(default_factory=list)
    deadline: date | None = None


@dataclass
class Operator:
    country: str
    nace_codes: list[str]


def _same_branch(a: str, b: str) -> bool:
    return a.startswith(b) or b.startswith(a)


def select_for_operator(items: list[Item], operator: Operator) -> list[Item]:
    selected = []
    for item in items:
        if item.jurisdiction not in ("EU", operator.country):
            continue
        # Untagged items (None or []) are horizontal rules and always shown, as documented.
        tags = item.nace_tags or []
        if tags and not any(
            _same_branch(tag, code)
            for tag in tags
            for code in operator.nace_codes
        ):
            continue
        selected.append(item)

    return sorted(selected, key=lambda i: i.deadline or date.max)


# ---------------------------------------------------------------------------
# Demo
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    items = [
        Item("X1", "EU", "Anti-dumping duty on cold-rolled steel", ["C24.1"], date(2026, 12, 1)),
        Item("X2", "EU", "Late payments in commercial transactions", [], date(2026, 12, 9)),
        Item("X3", "AT", "Scrap shipment amendment", ["C24"], date(2026, 12, 5)),
        Item("X4", "DE", "Steel recycling quotas", ["C24"], date(2026, 12, 3)),
        Item("X5", "EU", "Toy safety: online marketplaces", ["G47"], None),
    ]
    operator = Operator(country="AT", nace_codes=["C24.4", "C25"])

    for it in select_for_operator(items, operator):
        print(f"{it.id}  {it.deadline}  {it.title}")
