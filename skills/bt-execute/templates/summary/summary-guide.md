# Plan summary — `.agents/specs/<slug>/documents/<slug>_summary.html`

The plan summary tells the people who use the product what this plan did for them, without any technical
detail. The After Action Report on the dashboard is the developer's record. This is the plain-language version
for everyone else: product owners, testers, support staff and users. It is a formatted page that opens straight
from disk, linked from the After Action Report.

## Files

Like the dashboard, the page is a fixed template and the content is data:

- **`documents/<slug>_summary.html`** is this folder's `summary.html`, copied into the feature's `documents/`
  folder with `{{slug}}` replaced, and never otherwise edited. Only `dashboard.html` sits at the feature root. Copy it again whenever you write the data, so layout fixes
  reach older features.
- **`documents/<slug>_summary.js`**, beside the page, holds everything the page shows, as strict JSON behind the one-line prefix
  `window.PLAN_SUMMARY =`. Use double-quoted keys, no comments and no trailing commas, and always write the
  whole file. `summary.template.js` is a complete worked example of a fix plan; replace every value in it.
- After writing both, set `afterAction.planSummary` to `"documents/<slug>_summary.html"` (with the real
  slug) in the dashboard data, so the After Action Report links to the page.

## When

- Write it only when a run ends with the plan **`complete`**, meaning every task in the plan file is `- [x]`.
  A `paused` or `incomplete` plan gets no summary, because a summary of unfinished work would mislead.
- **A reopened plan** is one that had tasks added after it was complete. The summary already written stays as it
  is while the added tasks run. The run that completes them rewrites the summary so it describes the plan as it
  now stands. Keep the first date in `stamp` and add the new one, `"Fixed on 2026-10-19; updated on
  2026-11-02"`, and say in the lead what the update added.

## Who it is for, and how it reads

- **Readers who never see the code.** Name what they see: screens, panels, buttons and settings, with the
  on-screen labels in `**bold**` exactly as they appear. Never include file names, class or function names, task
  IDs, commit hashes, test counts, phase numbers or agent roles.
- **Concrete, not vague.** Use real values: sizes, counts, devices, the symptom a user would have noticed
  ("came out at 3400×2200 one time and 2528×1696 another"). Prefer one exact sentence to three general ones.
- **Short sentences in plain words.** Use a list when there are three or more parallel items, and a numbered
  list when the order matters or later text refers to the items.
- **Only what is true and was checked.** Take every fact from the spec, the plan, the run log and the After
  Action Report. If something was not checked, do not say it works.
- **Text may use `**bold**` and nothing else.** Everything else is shown as plain text.

## Fields

| Field | Meaning |
|---|---|
| `schema` | `1` |
| `title` | the plan's own title, short: `"Camera Session"` |
| `outcome` | what the plan delivered, stated as a result a user would recognise: `"A saved view remembers every render setting"`. The page's headline |
| `stamp` | `"Fixed on YYYY-MM-DD"` for a fix, `"Delivered on YYYY-MM-DD"` for a new feature, `"Finished on YYYY-MM-DD"` for anything else (a speed-up, a clean-up); a reopened plan adds `"; updated on YYYY-MM-DD"` |
| `lead` | a list of paragraphs, usually one: two or three sentences on what now works |
| `sections` | `[{ "kind", "heading", "blocks" }]`, in the order below |
| `writtenAt` | `"YYYY-MM-DD HH:MM"` from the shell clock |

A section's `blocks` is a list. Each block is a **paragraph** (a string) or a **list**:
`{ "list": [items], "numbered": true }` (leave out `numbered` for bullets). A list item is a string, or
`{ "text", "items": [...], "numbered" }` when the item has its own sub-list. `kind` picks the section's colour.

## Sections

The title, the stamp and the lead are always present. The sections come in this order. **Leave out any section
that does not apply to this plan**: no empty section, no "N/A" and no filler. **Adapt a heading's wording to the
plan** where the default does not fit (for example, a new feature has nothing "wrong").

1. **`impact` — "The plan summary"**: the plan in short for a non-technical reader, and what it means for them.
   Cover whether anything needs migrating, what behaves differently for existing content, and any one-time
   action that fixes it. Leave it out when nothing changes for existing users, data or content.
2. **`wrong` — "What was wrong"**: for a fix, a numbered list of the problems as a user experienced them, each
   with its visible symptom. For a feature, use **"Why it was needed"**: what users could not do before. For a
   speed-up, use **"What was slow"**. Leave it out when there is nothing to say.
3. **`changed` — "What has changed"**: one bullet per change, each beginning with a bold sentence that states
   the new behaviour. Each one should answer a point in section 2.
4. **`unchanged` — "What has not changed"**: known issues left alone on purpose, and the limits of the plan
   (settings that belong to the device, cases not covered), each with the reason. Leave it out when there are
   none.
5. **`checked` — "How it was checked"**: the setup (browser, device, which data, and whether anything was
   saved to a server), then the real scenarios that were run and the exact results they gave. Leave it out only
   when nothing a reader would recognise was checked.
