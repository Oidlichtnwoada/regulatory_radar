# Where `labels.extended.json` disagrees with `labels.json`

Both sets label the same corpus (`data/items.json`, as of 2026-11-16). The extended set was built from scratch:

- **Labelling:** three model annotators labelled all 53 items for all three profiles independently (159 item labels). None of them saw `labels.json`.
- **Vote:** the final label is the majority vote.
- **Review:** a fourth, sceptical reviewer re-checked every label and group and changed nothing.

**Procedure groups:** the 8 multi-item groups are identical in both sets, so both label the same 45 groups per profile.

**Labels:** for `metals_at` and `retail_es`, the sets disagree on 4 of 90 group labels (45 groups × 2 profiles). All three original annotators agreed on each of the four. A later blind re-annotation (three more annotators, different models) chose the extended label in all four cases (unanimously for three, 2 of 3 for `EU-LEX-0004`).

| Profile   | Group         | Item                                                                       | `labels.json` | Extended   |
| --------- | ------------- | -------------------------------------------------------------------------- | ------------- | ---------- |
| metals_at | `EU-LEX-0004` | Taxonomy screening criteria for the manufacture of primary aluminium       | relevant      | borderline |
| metals_at | `EU-CON-0007` | Council mandate on joint stockpiling of strategic raw materials            | relevant      | borderline |
| metals_at | `EU-EP-0034`  | Gas supply: coordinated demand reduction for large industrial consumers    | borderline    | relevant   |
| retail_es | `ES-BOE-0050` | Aid vouchers for the digitalisation of small and micro enterprises (Spain) | borderline    | relevant   |

## Why we prefer the extended labels here

**`EU-LEX-0004`: relevant → borderline.**

- **No duty:** the item has no summary or deadline, and the EU Taxonomy creates no obligation or cost for metal producers. It defines when an activity counts as "green" for financing and disclosure. That matters only to members who report under CSRD or seek green finance.
- **Narrow scope:** it covers only primary aluminium smelting, a narrow part of C24 (C24.42).
- **Verdict:** a desk should know it exists (green finance, CSRD reporting of large members), which is borderline. It is nothing to act on.

**`EU-CON-0007`: relevant → borderline.**

- **No duty:** the item describes voluntary joint purchasing and stockpiling. It creates no obligation for members.
- **Indirect effect:** it may ease supply of nickel, cobalt and rare earths, which are alloying inputs.
- **No open window now:** the Council has fixed its mandate and the item has no deadline. The procedure (2026/9088(COD)) still has later stages, so the desk can follow it.
- **Verdict:** an indirect effect without a current window fits borderline.

**`EU-EP-0034`: borderline → relevant.**

- **Possible duty:** member states *may* oblige large industrial gas consumers to cut demand when a Union-wide supply alert is declared. It is optional and conditional, but it falls on the members directly.
- **Direct hit:** smelters, rolling mills and foundries are among the largest industrial gas users. The profile says "energy costs … matter most".
- **Lever:** a plenary vote with an amendment deadline (2026-12-03) is exactly the window in which a sector desk lobbies.
- **Verdict:** a direct exposure of the members with an open window to act, so it is relevant.

**`ES-BOE-0050`: borderline → relevant.**

- **Funding for members:** these are Spanish aid vouchers for small and micro enterprises, covering invoicing, online sales and cybersecurity.
- **Fits the profile:** the profile names "shops and online stores", and the vouchers cover online sales. We assume many of the members are small or micro shops; the profile does not say so.
- **Verdict:** an adopted call for funding the members can claim is something the desk should pass on, so it is relevant. The standard set's borderline is defensible because the vouchers are not aimed at retail.

## Effect on the metrics

In each of the four cases, one of the two sets says borderline, and borderline labels are not scored. So the sets never pull in opposite directions: rating all four groups relevant scores full marks on both.

The disagreements still matter. A classifier that follows the extended view and rates `EU-LEX-0004` or `EU-CON-0007` borderline loses strict recall on `labels.json`, and one that rates `EU-EP-0034` or `ES-BOE-0050` borderline loses strict recall on the extended set.

The offline classifier follows the extended set exactly (tier agreement 1.00 on all three profiles). On `labels.json` that costs strict recall for `metals_at` (12/14: `EU-LEX-0004` and `EU-CON-0007` are rated borderline, so they are still shown), while `EU-EP-0034` and `ES-BOE-0050` are rated relevant where the standard set says borderline, which is not scored. See the README for the full table.

## Re-annotation check (2026-11-24)

The blind re-annotation matched the extended set's majority label everywhere except two places. Neither conflicts with `labels.json`, and no label was changed:

- **`agrifood_pl` `EU-EP-0001`** (emissions-trading benchmarks): extended says borderline, all three re-annotators said not_relevant. Only a few large food installations are in emissions trading, so both are defensible; borderline is not scored.
- **`metals_at` `DE-GAZ-0021` and `EU-TRIS-0042`** (German drafts on recycled steel and aluminium content): both sets say not_relevant because the jurisdiction is DE, and two of three re-annotators said borderline (export market, TRIS standstill as a comment window). We keep the jurisdiction rule the standard set also applies.
