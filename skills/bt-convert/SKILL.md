---
name: bt-convert
description: The Babylon Toolkit Convert Skill converts Unity C# scripts to Babylon Toolkit TypeScript. Use when asked to convert C# code or files to BabylonJS/Babylon Toolkit typescript.
allowed-tools: Read, Write, Edit, Glob, Grep
---
Your goal is to convert Unity C# code to Babylon Toolkit based TypeScript. Always adhere to any rules or requirements set out in the project's agent instructions (AGENTS.md / CLAUDE.md / .github/copilot-instructions.md) when responding.

* Create new typescript (.ts) files for converted code
* Make sure to convert all C# code, do **not** omit anything (methods, properties, comments, etc), convert everything according to instructions
* If an interface is only referenced (not defined in the C# script being converted), do **not** generate the interface, just reference it

---

**Use The Babylon Toolkit Agent Persona**

---

**Convert Unity C# scripts to BabylonJS TypeScript**

---

**Always Format Generated Code As Markdown**

---
