# Plan summary — how to write `.agents/specs/<slug>/summary.md`

The plan summary tells the people who use the product what this plan did for them, without any technical
detail. The After Action Report on the dashboard is the developer's record. This is the plain-language version
for everyone else: product owners, testers, support staff and users.

## When

- Write it only when a run ends with the plan **`complete`**, meaning every task in the plan file is `- [x]`.
  A `paused` or `incomplete` plan gets no summary, because a summary of unfinished work would mislead.
- **A reopened plan** is one that had tasks added after it was complete. The summary already written stays as it
  is while the added tasks run. The run that completes them rewrites the summary so it describes the plan as it
  now stands. Keep the first date in the lead and add the new one:
  `**Fixed on 2026-10-19; updated on 2026-11-02.**`, then one sentence on what the update added.
- After writing it, set `afterAction.planSummary` to `"summary.md"` in the dashboard data, so the After
  Action Report links to it.

## Who it is for, and how it reads

- **Readers who never see the code.** Name what they see: screens, panels, buttons and settings, with the
  on-screen labels in **bold** exactly as they appear. Never include file names, class or function names, task
  IDs, commit hashes, test counts, phase numbers or agent roles.
- **Concrete, not vague.** Use real values: sizes, counts, devices, the symptom a user would have noticed
  ("came out at 3400×2200 one time and 2528×1696 another"). Prefer one exact sentence to three general ones.
- **Short sentences in plain words.** Use a list when there are three or more parallel items, and a numbered
  list when the order matters or later text refers to the items.
- **Only what is true and was checked.** Take every fact from the spec, the plan, the run log and the After
  Action Report. If something was not checked, do not say it works.

## Structure

The sections below come in this order. **Leave out any section that does not apply to this plan**, with no
empty heading, no "N/A" and no filler. **Adapt a heading's wording to the plan** where the default does not fit
(for example, a new feature has nothing "wrong").

1. **`# <Plan title>: <the outcome in one line>`**: the plan's own title, followed by what it delivered,
   stated as a result a user would recognise ("Camera Session: a saved view remembers every render setting").
   Always present.
2. **The lead**: always present. It opens with a bold date, `**Fixed on YYYY-MM-DD.**` for a fix,
   `**Delivered on YYYY-MM-DD.**` for a new feature, or `**Finished on YYYY-MM-DD.**` for anything else (for
   example a speed-up or a clean-up). Follow the date with two or three sentences on what now works.
3. **`## The plan summary`**: the plan in short for a non-technical reader, and what it means for them. Cover
   whether anything needs migrating, what behaves differently for existing content, and any one-time action
   that fixes it. Leave the section out when nothing changes for existing users, data or content.
4. **`## What was wrong`**: for a fix, a numbered list of the problems as a user experienced them, each with
   its visible symptom. For a feature, use **`## Why it was needed`**: what users could not do before. For a
   speed-up, use **`## What was slow`**. Leave it out when there is nothing to say.
5. **`## What has changed`**: one bullet per change, each beginning with a bold sentence that states the new
   behaviour. Each one should answer a point in section 4.
6. **`## What has not changed`**: known issues left alone on purpose, and the limits of the plan (settings that
   belong to the device, cases not covered), each with the reason. Leave it out when there are none.
7. **`## How it was checked`**: the setup (browser, device, which data, and whether anything was saved to a
   server), then the real scenarios that were run and the exact results they gave. Leave it out only when
   nothing a reader would recognise was checked.

## Example (a fix plan, with every section present)

```markdown
# Camera Session: a saved view remembers every render setting

**Fixed on 2026-10-19.** A saved Camera Session view now keeps every setting its render depends on. Loading a
view shows all of them in the panel. **Render Current View** and **Render All Cameras** now render each view
with its own settings.

## The plan summary

Saved views keep working; nothing needs migrating. Two things are worth knowing:

- **Per-instance object IDs come back on** for a view saved before this fix, because that view never stored the
  setting. If a view was used with it off, turn it off and Update the view once.
- **An orthographic view saved before this fix still gets its framing size worked out the old way** each time it
  is loaded. It no longer gets wider. Update it once to store its framing.

## What was wrong

1. **Render All Cameras ignored each view's own output settings.** It used the panel's width, height, size
   preset, screen percentage and Image Types for every view, so the same camera could come out at 3400×2200 one
   time and 2528×1696 another.
2. **Load did not show every saved setting in the panel.** The Line Sources boxes always showed unticked, and
   ticking one turned the other three off.

## What has changed

- **Both render buttons render each view with its own saved settings.** A view now comes out the same from
  Render All as from Load + Render Current View.
- **Load shows every saved setting in the panel**, including Line Sources. Ticking one box changes only that one.

## What has not changed

- **Some settings belong to the device, not to a view**, so they are not saved with one: the performance level
  and the anti-aliasing sample count (lower on phones). The same view can look slightly different on a phone
  and on a desktop.

## How it was checked

We tested in Chrome using local cards only; nothing was saved to the server.

- Render All was run on three views with the panel left at 640×480. Each view rendered at its own size with its
  own images: one at 2528×1696, one at 1200×800, and one with no saved output settings at the panel's 640×480.
- Pressing Update right after Render All changed nothing in the last view.
```
