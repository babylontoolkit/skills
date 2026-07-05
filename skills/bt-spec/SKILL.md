---
name: bt-spec
description: The Babylon Toolkit Spec Skill creates a feature spec file and branch from a short idea. Use when asked to spec out, plan, or scaffold a new feature.
allowed-tools: Read, Grep, Glob, Write, WebFetch(domain:raw.githubusercontent.com), Bash(git switch:*)
---

You are helping to spin up a new feature spec for this application, from a short idea provided in the user input below. Always adhere to any rules or requirements set out in the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md) when responding.

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

## ⚠️ The Project Specification (SPEC.md) — read before drafting

The project's **SPEC.md** at the repository root is the source of truth for the project: it defines the durable architecture, game systems, conventions, and decisions. **Read it before drafting any feature spec.**

- Align the feature idea to the existing architecture, systems, and conventions in SPEC.md. The feature spec you produce must be derived from and constrained by SPEC.md.
- **If the feature idea conflicts with SPEC.md** (contradicts an architectural decision, a system boundary, or a convention), STOP and flag the conflict to the user before writing the spec. Do not silently override the project spec.
- **Classify the feature's `spec_impact`:** it is `yes` if implementing the feature would add or change a game system, a convention, a dependency, or an architectural decision recorded in SPEC.md — otherwise `no`. This drives whether the plan will include a SPEC.md write-back task, so classify honestly.
- If SPEC.md is missing or is still a stub with no real content, record that in the feature spec (`"No project SPEC.md content yet — following existing codebase conventions."`) and continue.

---

## Planning mode — do not implement

This command runs in PLANNING MODE. Research read-only and produce ONLY the spec document and its git branch. Do NOT implement the feature, edit any existing application/source files, or run build, test, or other shell commands. The only file you may create is the spec markdown described below.

## High level behavior

Your job will be to turn the user input above into:

- A human friendly feature title in kebab-case (e.g. new-heist-form)
- A safe git branch name not already taken (e.g. project/feature/new-heist-form)
- A detailed markdown spec file under the _specs/ directory

Then save the spec file to disk and print a short summary of what you did.

## Step 1. Check the current branch

Check the current Git branch, and abort this entire process if there are any uncommitted, unstaged, or untracked files in the working directory. Tell the user to commit or stash changes before proceeding, and DO NOT GO ANY FURTHER.

## Step 2. Parse the arguments

From `arguments`, extract:

1. `feature_title`  
   - A short, human readable title in Title Case.  
   - Example: "Card Component for Dashboard Stats".

2. `feature_slug`  
   - A git safe slug.  
   - Rules:  
     - Lowercase 
     - Kebab-case 
     - Only `a-z`, `0-9` and `-`  
     - Replace spaces and punctuation with `-`  
     - Collapse multiple `-` into one  
     - Trim `-` from start and end  
     - Maximum length 40 characters  
   - Example: `card-component` or `card-component-dashboard`.

3. `branch_name`  
   - Format: `project/feature/<feature_slug>`  
   - Example: `project/feature/card-component`.

If you cannot infer a sensible `feature_title` and `feature_slug`, ask the user to clarify instead of guessing.

## Step 2.5 Apply the project design system (DESIGN.md)

This project's design system is defined in the `DESIGN.md` file at the repository root. `DESIGN.md` is the single source of truth for all design decisions — do NOT pull styling from Figma, external links, or invent your own values. (Figma may be used in a separate process to author `DESIGN.md`, but specs reference `DESIGN.md`, never Figma directly.)

If the feature has any UI or visual surface:

1. Read `DESIGN.md`. If it is missing or has no real design system yet, record this note in the spec and continue: `"No DESIGN.md design system found — follow the existing UI conventions already in the codebase."`
2. Identify the parts of the design system relevant to this feature and cite them, by name, in the spec — for example:
   - Layout and spacing scale
   - Typography tokens (font family, size, weight)
   - Color tokens and semantic roles (primary, surface, border, error, etc.)
   - Border radius, shadows, elevation
   - Shared components, icons, buttons and inputs the feature should reuse
3. Summarise these as 3 to 8 concise bullet points that reference the `DESIGN.md` tokens and components by name, so implementation stays consistent with the system.

If the feature is purely non-visual (no UI), note that no design system tokens apply and continue.

## Step 3. Switch to a new Git branch

Before making any content, switch to a new Git branch using the `branch_name` derived from the `arguments`. If the branch name is already taken, then append a version number to it: e.g. `project/feature/card-component-01`

## Step 4. Draft the spec content

Create a markdown spec document that Plan mode can use directly and save it in the _specs folder as `<feature_slug>_spec.md`. Use the exact structure as defined in the feature spec template file @FEATURE.md located at the project root. The template includes a required `spec_impact` header field and a `Project Spec Alignment` section — fill both in from your SPEC.md read above (cite the SPEC.md sections the feature relies on, describe how it fits the architecture, and for `spec_impact: yes` state exactly what will change in SPEC.md and in which section). Do not add technical implementation details such as code examples. If the feature spec template file is missing, create a new feature spec file with the following sections:
```
# Feature Spec Template

> This is the template bt-spec uses to author `_specs/<feature_slug>_spec.md`.
> Copy this structure verbatim. A feature spec is derived **from** and constrained
> **by** the project [SPEC.md](SPEC.md) — the `Project Spec Alignment` section and
> the `spec_impact` header field are required, not optional.

---

# Spec for <feature-name>

branch: project/feature/<feature-name>
design_system: DESIGN.md
spec_impact: <yes|no>   # yes if this feature adds/changes a system, convention, dependency, or architectural decision in SPEC.md

## Summary
<one-paragraph description of the feature>

## Project Spec Alignment (from SPEC.md — REQUIRED)
- SPEC.md sections this feature relies on or must conform to: <cite by name, e.g. "Game Systems › Inventory", "Conventions">
- How this feature fits the existing architecture: <...>
- **spec_impact = yes** → what will change in SPEC.md and which section(s): <architecture / system / convention / decision / dependency + the new state>
- **spec_impact = no** → confirm this feature introduces no architectural, system, convention, or dependency change.
- Conflicts with SPEC.md (if any): <describe; these must be resolved/flagged before planning>

## Functional Requirements
- ...

## Design System Reference (from DESIGN.md, only if the feature has UI)
- DESIGN.md tokens/components this feature uses: ...
- Layout / spacing / typography notes: ...
- Key visual constraints: ...

## Possible Edge Cases
- ...

## Acceptance Criteria
- ...

## Open Questions
- ...

## Testing Guidelines
Create a test file(s) in the ./tests folder for the new feature, and create meaningful tests for the following cases, without going too heavy:
- ...
```

## Step 5. Final output to the user

After the file is saved, respond to the user with a short summary in this exact format:

Branch: <branch_name>
Spec file: _specs/<feature_slug>_spec.md
Title: <feature_title>

Do not repeat the full spec in the chat output unless the user explicitly asks to see it. The main goal is to save the spec file and report where it lives and what branch name to use.
