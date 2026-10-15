<!-- Fictional shop, names, paths, dates and measurements; Markdown structure retained from a prose-parser fixture. -->

## What I checked, and the one thing I can't check

I judged Mina's six points against the shop's own saved evidence: the frozen experiment plan and records (`/example/shop-project\.work\experiment-review\launch-ready\plan.json`, `exact-changes.csv`, `launch-record.json`, `monitoring\STATE.json`), the Oct-1–7 Stats/Search capture (`browser\etsy-search-oct1-7-all.json`), the competitor and whole-store analyses (`next-step-research\...`), the current rules (`...\.work\vps-seo\HANDOFF.md`, `boost\SKILL.md`, `improvement\SKILL.md`, the Sept improvement notes) and the current media pipeline.

Two boundaries up front:

- **There is no result yet.** Post window is 2025-06-10 → 16; `monitoring\STATE.json` still says `"status": "scheduled_waiting"`, `"capture_dates": []`, first capture 2025-06-11 08:00 (Etc/UTC), single whole-window read 2025-06-17. Nothing below is a verdict on whether the experiment works.
- **Her six points are not recorded in any file I can read.** Grepping the report tree and the experiment tree for `فیدبک` / `بازخورد مینا` returns nothing; they exist only in this conversation. So I judged them against the shop's evidence, not against a saved note of what she said.

I'm not deciding what to do about them; several bear directly on the arm already running, which is worth knowing.

## Verdicts in one table

| # | Her point | Verdict |
|---|---|---|
| 1 | Short titles bring little traffic; use all 150 | Directionally fair, overstated; "must reach 150" is explicitly rejected by our own rules |
| 2 | Count in title is not useful | **Supported**, and our own rule already says it |
| 3 | Saying where the buyer can use it is useful | **Supported in direction** (one true occasion/use), but it is occasion language, not tool language, that shows up |
| 4 | Journal/badge steering didn't work; packs are graduation/wedding | **Supported by the shop's record**, with real caveats |
| 5 | Tags repeat "png"; ExampleMarket says don't repeat much | Observation **correct** (7–9 of 13 in the changed sets); the "ExampleMarket says" attribution is only partly documented; our own rules already forbid it |
| 6 | Successful shops put the whole title in the first paragraph | Goal right, method not supported and against our own rule and against every comparable we read |

## 1. Title length

- 150 is a hard cap, not a target: `HANDOFF.md` §Titles — "Hard maximum: **150 characters**. Recent research describes **roughly 123–143 useful characters**, not a mandatory minimum or a requirement to hit 150. Older workflow text also says 120–150, 120–146, or near 146–150; do not turn those varying editorial targets into conflicting validators." The older 120–150 text is where her instinct comes from, and `improvement/SKILL.md` does say "Fill close to 150 characters only when the words are useful and non-repetitive." So she is arguing from the shop's own older standard.
- The "short titles ⇒ little traffic" mechanism is not measured anywhere. Inside the shop there is no short-title contrast at all: the 24 sampled titles run 111–146 chars (mean ≈129), and the shortest of them (111, woodland) was near the top of the Oct 1–7 Search table (8 visits) while a 143-char and a 146-char sibling sat at 1–2.
- The market has both: comparables range 48 chars ("Watercolor Cute Fruits Clipart, Kawaii Food (PNG)", 10 item reviews) to 137 with repeated "clipart" (PaperHarborExample), and the sampled shops average ~100–143 (`boost/SKILL.md`).
- Practical reading: "don't delete useful words to be clean" is well supported (`boost/SKILL.md`: "Do not make titles overly clean/minimal just because ExampleMarket AI/Gemini suggests it"). "Must use all 150" is not.
## 2. Count in the title

Supported, and it matches our written rule almost verbatim: "Front-load what buyers search for, not count, `Digital Download`, `Commercial Use`, or a generic `Transparent PNG` package label. Count can be a value hook when genuinely useful, otherwise keep it in supporting fields" (`HANDOFF.md` §Titles), and `improvement/SKILL.md`: "Do not lead with count unless count/value is the search hook; for CloudberryExample niche packs, count often belongs in description/cart/image rather than the first title phrase."

Her premise that the count is already visible is true in the current pipeline and in the live listings: the cover subtitle carries the count, the cover renders a top-right count ribbon (`pipeline/media/cover.py` → `packer/render.py` `_draw_pack_count_badge`, which draws the number plus "png"), image 10 has a `{n} PNG` card (`pipeline/media/listing_images.py`), and the cover alt texts the shop publishes say e.g. "cover with **30** transparent PNG paper animal characters"?—?plus every description has "- 28 individual transparent PNG clipart files" under WHAT'S INCLUDED.


[... the middle sections are left out of this trimmed copy ...]

## What this adds up to

Her six points, taken together, describe a specific editorial direction: keep titles long and use the space on true occasions/uses, don't lead with the count, stay in the nursery/graduation/wedding lane rather than the badge/journal/classroom lane, clean the mechanical "png" repetition in tags, and make the first description sentence plainly say what is being sold. Points 2, 4 and 5 align with our written rules; points 1, 3 and 6 align with the *spirit* of the rules (don't strip useful words; one true occasion; opening paragraph carries the buyer language) but are stated more absolutely than the evidence supports or are paired with a method the evidence contradicts.

The uncomfortable part is the direction mismatch with what launched on 2025-06-09: **A is the arm her points 1–3 argue against** (shorter, count-led, occasion removed), **B is the arm her point 4 argues against** (longer, badge/packaging/classroom). What would settle these, in order: the Oct 10–16 Stats window read on 2025-06-17 (for A and B), a listing-level test of a description opening (for point 6, currently untested), a real tag-diversity test rather than a one-tag swap (for point 5), and her own browsing screenshots for the competitor claim in point 6.
