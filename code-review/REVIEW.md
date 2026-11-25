# Part B: review of `snippet.py`

## Fix first: untagged items are dropped instead of always shown

The docstring promises that items without NACE tags (horizontal rules) are always shown, but `any()` over an empty list is `False`, so the code skips them: the demo drops `X2` (late payments). With `nace_tags: null`, as in 40 of the 53 seed items, it raises `TypeError` instead. A missed rule is the costliest failure of a radar, and here it hits exactly the rules that concern every member, so this goes first.

**Fix** ([`snippet_fixed.py`](./snippet_fixed.py), two lines): treat `None` as no tags, and filter by sector only when there are tags.

```python
tags = item.nace_tags or []
if tags and not any(_same_branch(tag, code) for tag in tags for code in operator.nace_codes):
    continue
```

## Other issues I would not ship

| #   | Issue                                    | Why it matters                                                                                             | Fix                                                                |
| --- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | Sorting by deadline ignores today        | Expired deadlines rank above open windows                                                                  | Rank with an `as_of` date and actionability tiers                  |
| 2   | No total order                           | Equal deadlines keep input order, so output depends on source order                                        | Tie-break on `id`                                                  |
| 3   | `_same_branch` is a string prefix test   | `"C2"` matches `"C24"`; `"C2441"` vs `"C24.4"`, case and whitespace fail                                   | Normalise, then compare code lineages (`C24.42 → C24.4 → C24 → C`) |
| 4   | "Untagged = relevant to everyone"        | Untagged means "not tagged", not "horizontal" (`ES-BOE-0026`, a courts reform, is not relevant for retail) | Decide untagged items from their text                              |
| 5   | Case-sensitive, unvalidated jurisdiction | `"at"` silently drops Austrian items                                                                       | Validate ISO 3166-1 codes at the boundary                          |
| 6   | Types are not enforced                   | `nace_tags` receives `None`, deadlines arrive as strings from JSON                                         | Parse once at the edge (e.g. pydantic)                             |
| 7   | No tests                                 | Each issue above is a one-line regression test                                                             | Add them with the fix                                              |
