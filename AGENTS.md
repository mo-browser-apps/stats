<!-- BEGIN:mobrowser-agent-rules -->

# Do not rely on training data for MōBrowser

Your training data for MōBrowser is outdated. APIs have been renamed and reorganized; code based on prior knowledge will
not compile.

**Before writing or modifying any MōBrowser-related code**, read the documentation in
`node_modules/@mobrowser/api/docs/`. In the docs, you will find two folders:

- `node_modules/@mobrowser/api/docs/guides/` - contains detailed documentation about architecture, project structure,
  multiple process model, Inter-Process Communication (IPC), native C++ module, features, guides, examples, and more.
- `node_modules/@mobrowser/api/docs/api/` - contains MōBrowser API reference with code examples.

Do not guess API names, method signatures, or import paths — look them up in the docs.

If the `docs/` directory is missing, ask the user to run `npm run gen`. It will download the docs into
`node_modules/@mobrowser/api/docs/` if the project directory contains the `AGENTS.md` file.
<!-- END:mobrowser-agent-rules -->

# Project-specific agent instructions

This project is MoStats, a compact macOS system resources monitor built with MōBrowser, React, TypeScript, Shadcn-style
UI, and optional native C++ support.

## Read Order

Before non-trivial work, read:

- `moproduct.yaml`
- `docs/PROJECT_BRIEF.md`
- `DESIGN.md` before writing or editing renderer UI
- `docs/ARCHITECTURE.md`
- `docs/REFERENCE_MAP.md`
- `docs/IMPLEMENTATION_PLAN.md`
- `docs/ITERATION_PROTOCOL.md`
- `docs/AGENT_WORKFLOW.md`
- `docs/VERIFICATION.md`
- `docs/MENTAL_MODEL.md`
- `docs/FIRST_ITERATION_CONTRACT.md` before the first implementation iteration

## Non-Negotiable Rules

- Keep the official MōBrowser split:
  - `src/main` owns app lifecycle, windows, tray/menu bar, dialogs, notifications, IPC services, and privileged OS work.
  - `src/renderer` owns React UI and presentation state only.
  - `src/native` owns narrow platform probes only.
- Use typed protobuf IPC for renderer-to-main communication. Do not bypass the generated client.
- Use React 19, TypeScript, local Shadcn-style components, Tailwind tokens, and `lucide-react` icons.
- Do not introduce a second UI component library without explicit user approval.
- Tokenize reusable styling through `src/renderer/index.css` and `DESIGN.md`. Do not introduce random colors, fonts, or one-off visual systems.
- Keep the product compact: one main window, tray/menu bar presence, no preferences screen unless the product brief changes.
- Static analysis must be zero-warning. Do not suppress lint/static-analysis warnings without explicit user confirmation.
- Do not manually edit generated files under `src/main/gen`, `src/renderer/gen`, or `src/native/gen`; update protobuf files and run `npm run gen`.
- Do not invent MōBrowser API names, native APIs, metric sources, or UI requirements. Use official docs, local references, or explicit unavailable states.

Follow the workflow in `docs/AGENT_WORKFLOW.md`:

- Research and plan before broad changes.
- Critique architecture and testing risks before implementation.
- Use `docs/REFERENCE_MAP.md` when borrowing patterns from nearby apps.
- Keep renderer code presentation-focused.
- Keep main-process code responsible for app lifecycle, tray behavior, and metrics orchestration.
- Use native code only for narrow macOS integrations that are not reliable from TypeScript.
- Update `docs/MENTAL_MODEL.md` after architecture or behavior changes.
- Run `npm run verify` before completing implementation work.

## Code Documentation

- Use multiline JSDoc blocks for public classes and public methods where ownership or behavior is not obvious.
- Keep comments short and useful. Explain role, constraints, or non-obvious decisions, not line-by-line mechanics.
- Use plain ASCII punctuation in new code and docs unless editing existing text that already uses a specific character set.

## Lint Suppression Policy

Suppressing a linter diagnostic with `eslint-disable`, `stylelint-disable`, `NOLINT`, or equivalent is prohibited without explicit user confirmation. If suppression appears necessary, ask the user first and document the approved reason directly above the suppression.
