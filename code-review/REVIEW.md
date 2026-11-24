# Part B: review of `snippet.py`

## Fix first: untagged items are dropped, though the docstring promises to always show them

The docstring says items without a NACE tag are horizontal rules and **always shown**. The code does the opposite: `any()` over an empty tag list is `False`, so every untagged item is skipped. Run the demo and `X2` (late payments, the textbook horizontal rule) is missing.

With real data it is worse. Most seed items carry `nace_tags: null`, so `item.nace_tags` is `None` and the generator raises `TypeError`. A chamber either gets a crash or silently loses exactly the rules that concern all its members. A missed rule is the most expensive failure of a radar, so this goes first.

**Fix** (in [`snippet_fixed.py`](./snippet_fixed.py), minimal diff): treat `None` as "no tags", and only apply the sector filter when there are tags.

```python
tags = item.nace_tags or []
if tags and not any(_same_branch(tag, code) for tag in tags for code in operator.nace_codes):
    continue
```

## What else I would not ship

1. **Ranking ignores the reference date.** "Soonest deadline first" puts already _expired_ deadlines on top, above open windows. It needs an `as_of` date and actionability tiers (open window, then vote, then standstill, then adopted).
2. **The tie-break depends on input order.** Items with equal deadlines keep their input order, so the output is not deterministic across sources. Add a total ordering (deadline, then id).
3. **`_same_branch` is a raw string prefix test.**
   - It accepts invalid parents (`"C2"` matches `"C24"`) and mixed notations (`"C2441"` vs `"C24.4"`).
   - It breaks on case and whitespace (`"c24"`, `" C24"`).
   - Hierarchy should be explicit: compare code lineages (`C24.42 → C24.4 → C24 → C`) after normalisation.
4. **The horizontal-rule assumption itself is wrong for the data.** `nace_tags = []` means "not sector-specific", not "relevant to everyone" (`ES-BOE-0026`, courts reform, is not relevant for retail). Untagged items need a text-based decision, not an automatic yes. The fix above makes the code honest to its docstring; the docstring's rule is still too blunt for production.
5. **Jurisdiction comparison is case-sensitive and unvalidated.** `"at"` vs `"AT"` silently drops national items. Validate ISO codes at the boundary.
6. **No validation or typing at the edges.** `nace_tags` is typed `list[str]` but receives `None`. Dates are assumed to be `date`, but JSON gives strings. Parse into the dataclass once (e.g. pydantic) rather than trusting the shape.
7. **No tests.** Each bug above is a one-line test (untagged item, `None` tags, expired deadline, `"C2"` vs `"C24"`, equal deadlines).
