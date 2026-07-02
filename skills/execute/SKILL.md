---
name: execute
description: Execute one task — or all remaining tasks — from a feature plan or spec file. Use when asked to run a task (e.g. "execute T1") or all tasks (e.g. "execute ALL").
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, WebFetch(domain:raw.githubusercontent.com)
---

Execute work from the referenced feature plan or spec file — either a single task, or every remaining task in order. Always adhere to any rules or requirements set out in the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md) when responding.

Use the user’s message after the skill name as the `arguments`.

---

## ⚠️ Required Reading Before Any Babylon Work

For any task involving Babylon, BabylonJS, or the Babylon Toolkit, first ensure you have already fetched and read the Babylon Toolkit Agent Reference in the current remembered session/context:

https://raw.githubusercontent.com/babylontoolkit/agent/main/reference.md

If you have not read it in this session/context, or you no longer remember it due to context loss/compaction, fetch and read it before scaffolding or writing code.

Do not refetch the Agent Reference repeatedly during the same remembered session/context, including across spec, plan, and execute phases, if you are still aware of its contents.

Treat the Agent Reference as the authority for conventions, API, and patterns. It routes to deeper docs. Fetch linked subpages only when they are relevant to the task, and do not refetch a subpage in the same remembered session/context unless you no longer remember it.

If a required fetch fails, STOP and tell me. Do not guess at the API.

---

## Step 1. Parse the arguments

From `arguments`, extract:

1. `source_file` — the plan or spec file reference to read tasks from (e.g. `_specs/new-heist-form_plan.md` or `_specs/new-heist-form_spec.md`).
2. `task_id` — either the identifier of a single task to execute (e.g. `T1`, `T2`, `T3.1`), or the literal word `NEXT` (case-insensitive, they are synonyms) to execute just the next remaining task, or the literal word `ALL` (case-insensitive) to execute every remaining task in order. If none is provided, list the available task ids and their checked/unchecked status from `source_file` and ask the user what to run. DO NOT guess or pick one yourself.

## Step 2. Single-task mode (`task_id` is a specific id)

Read `source_file` and find the task whose id matches `task_id`. If it cannot be found, print the list of available task ids from the file and STOP without implementing anything.

Then implement ONLY that single task. This is a hard rule:

- Do not start, scaffold, refactor for, or partially implement any other task, even if it looks trivial, related, or "while you're here".
- Stay within the scope described by the task. If the task is ambiguous or blocked by an unfinished prerequisite task, stop and tell the user instead of expanding scope.
- Follow all project rules in the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md) and any referenced spec/plan conventions.

When the task's acceptance criteria are met, mark ONLY this task complete: edit its line and change `- [ ]` to `- [x]` (leave every other task untouched). Never check the box for partial or unverified work.

Then report: the task id and what it required, the files you changed, any tests/build you ran and their result, and the next task id (for reference only — do NOT start it). Do not continue to the next task.

## Step 3. Next-task mode (`task_id` is `NEXT`)

`NEXT` is used to advance one task at a time without having to track the individual task id yourself.

Read `source_file` and collect the task checklist in order. Find the FIRST task still marked `- [ ]` (skip every task already marked `- [x]`). That task becomes the one to execute.

- If there is no unchecked task, report that the plan is already fully complete and STOP without changing anything.
- Otherwise, execute ONLY that single task, following the exact same scope discipline, project conventions, and completion rules as single-task mode (Step 2): implement only that task, then change its `- [ ]` to `- [x]` when its acceptance criteria are met, and leave every other task untouched.

Then report: the task id you just ran and what it required, the files you changed, any tests/build you ran and their result, and the next remaining task id (for reference only — do NOT start it). Do not continue to the next task; the user will run `NEXT` again to advance.

## Step 4. Run-all mode (`task_id` is `ALL`)

Execute every remaining task in the plan, in order, resuming wherever it was left off:

1. Read `source_file` and collect the task checklist in order.
2. Treat tasks already marked `- [x]` as DONE — skip them. The remaining `- [ ]` tasks are the work queue. (This is what makes `ALL` resumable across interruptions and even brand new conversations.)
3. For each unchecked task, in order, one at a time:
   a. Implement ONLY that task, following the same scope discipline and project conventions as single-task mode.
   b. As soon as its acceptance criteria are met, immediately edit `source_file` to change that task's `- [ ]` to `- [x]` BEFORE starting the next task. Persisting progress after each task is what lets a later run of the execute skill with `ALL` safely continue.
   c. If a task cannot be completed, is blocked, or its acceptance criteria are not met, STOP: leave it unchecked, do not touch any later task, and report which task failed and why.
4. When all tasks are checked (or you stopped early), report a summary: which tasks you completed this run, the current completed/total count, and whether the plan is now fully done.

Never check a box for partial, skipped, or unverified work in either mode.
