# NoteWize

Minimal, Linux-only, pure-Markdown note-taking app (real `.md` files in folders on disk; no database or cloud sync).

## Stack & Layout

- **Tech**: Electron, Svelte 5, Vite, TypeScript, Bun (keep dependencies minimal).
- `src/electron/` — Electron main process (`main.ts`) and preload (`preload.cts`).
- `src/renderer/` — Svelte 5 UI (`App.svelte`, `components/FileTree.svelte`, `app.css`).
- `src/shared/ipc.ts` — Shared IPC types.
- `TODO.md` — Planned features list.

## Commands

- `bun run check` — Type-check Electron (`tsc`) and renderer (`svelte-check`).
- `bun run build` — Build Electron and renderer bundles.
- `bun run dev` — Start Vite dev server and launch Electron.
- `bun run start` — Build and launch Electron.
- `bun run package:appimage` — Build and package a Linux AppImage into `release/` (electron-builder; config in `package.json` `build`).
