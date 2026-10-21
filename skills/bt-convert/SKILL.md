---
name: bt-convert
description: "The Babylon Toolkit Convert Skill converts source code to Babylon Toolkit TypeScript or JavaScript. Use when asked to convert source code or files to BabylonJS/Babylon Toolkit TypeScript or JavaScript."
allowed-tools: Read, Write, Edit, Glob, Grep
---
Your goal is to convert source code to Babylon Toolkit based TypeScript or JavaScript. Always adhere to any rules or requirements set out in the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md) when responding.

* Create new files for converted code in the target language: the one the brief names, else the one the project uses, else TypeScript (`.ts`). JavaScript (`.js`) output is equally supported — never push the developer to switch languages
* Make sure to convert all source code, do **not** omit anything (methods, properties, comments, etc), convert everything according to instructions
* If an interface is only referenced (not defined in the source code being converted), do **not** generate the interface, just reference it
* Follow the Agent Reference's **Coding Practices — ENFORCED** in every converted file: clean, professional TypeScript or JavaScript in the project's own language; meaningful full-word names, never one- or two-letter names or obfuscation; well-structured, readable, maintainable code for human developers; meaningful JSDoc on every class, function, method and public member (always written, but never a reason to fail a test or verification). Carry the source's doc comments (C# `///` XML docs and the like) across as JSDoc, and write meaningful JSDoc where the source has none
* Keep the source's public and serialized names (classes, methods, properties, fields) in camelCase, because exported Unity metadata binds to them by name. Give meaningful names to every local, parameter and helper the conversion introduces, and rename obfuscated or minified locals in the source to meaningful names
* Follow the Agent Reference's **Game UI Performance — ENFORCED** when the source updates UI. Unity scripts routinely write `Text.text`, `TMP_Text.text`, `Slider.value`, `Image.fillAmount` or a needle's rotation in `Update()` every frame, and other engines do the same in their render loop. Do not convert that cadence as-is: telemetry (speed, timers, bars, needles) is written only when its quantized shown value changes — through refs and one frame loop in a DOM HUD, or a changed-value check on a `@babylonjs/gui` control / `TOOLKIT.UserInterface.SetText` / `SetValue`; discrete values (score, ammo, lap) are set from the event that changed them; readouts nobody reads at 60 Hz are throttled; nothing is updated while hidden. Converted HUD code never pushes per-frame values through React state or posts them on the `EventBus` every frame (`ui-design-system.md` › **Live HUD Values — ENFORCED** and **Per frame or not**)
* Before finishing, re-read every converted file against the Coding Practices and Game UI Performance rules and fix every violation

---

# Invocation

```
/bt-convert <source-code> <conversion-brief>
```
- **`<source-code>`** — the source code to convert. This is the *blueprint*.
- **`<conversion-brief>`** — how to convert it. This is the *variable*.
- If either is missing, ask for it before starting. Never guess a URL.

Example:
```
/bt-convert → path/to/file.cs → "Convert to Babylon Toolkit TypeScript"
/bt-convert → path/to/file.cs → "Convert to Babylon Toolkit JavaScript"
```

---

**Use The Babylon Toolkit Agent Persona**

---
