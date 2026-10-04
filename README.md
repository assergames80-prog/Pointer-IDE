# Pointer

**Pointer** is an AI-first code editor for desktop, in the spirit of Cursor. It is built on Electron and Monaco (the editor inside VS Code) and runs a **real coding agent** on top of **Google Gemini** and **Groq**.

The agent is not sandboxed. It reads and writes the real files on your disk and runs real commands in your shell (PowerShell on Windows, your login shell on macOS/Linux). File edits are recorded, so you can review or undo them.

![Pointer](build/icon.png)

## Features

- **Agent mode**: describe a task and the agent explores the project, edits files, runs builds and tests, reads the output and keeps going until it's done. Tools:
  - `list_dir`, `read_file`, `search_text` (grep), `find_files` (glob)
  - `write_file`, `edit_file`, `delete_path`, `move_path`
  - `run_command`, with live output and background processes for dev servers
  - `process_control`, `web_fetch`
- **Ask mode**: read-only Q&A about your code.
- **Review & undo**: every agent edit shows an inline diff. You can open a side-by-side review, undo a single file, or click **Undo all** for a whole run.
- **Command approval**: by default the agent asks before running terminal commands or deleting files. Choose *Always allow* (or Settings → Agent → *Auto-run everything*) for full autonomy.
- **Ctrl+K inline edit**: select code, describe the change, then accept (Ctrl+Enter) or reject (Esc) the inline diff.
- **Tab autocomplete**: ghost-text completions from a fast model (Groq GPT-OSS 20B by default).
- **@-mentions and context**: attach files with `@`, drag files into the chat, or press Ctrl+L to send the current selection. The current file is included automatically.
- **A full editor**: Monaco with syntax highlighting for 80+ languages, multi-tab editing, a file explorer (create, rename, delete, drag & drop), project-wide search, quick open (Ctrl+P), a command palette (Ctrl+Shift+P), an integrated terminal (real PTY), dark and light themes, and auto save.
- **Project rules**: `.pointerrules`, `.cursorrules` and `AGENTS.md` in the open folder are added to the agent's instructions automatically.
- **Chat history**: chats are saved per workspace.

## Models & API keys

Open **Settings → Models & Keys** (Ctrl+,) and paste one or both keys:

| Provider | Get a key | Format |
| --- | --- | --- |
| Google Gemini | <https://aistudio.google.com/apikey> | `AQ.…` (new Auth keys) or `AIza…` (legacy) |
| Groq | <https://console.groq.com/keys> | `gsk_…` |

### About Google's new `AQ.` keys

Google AI Studio now issues **Auth keys** that start with `AQ.` instead of the old `AIza…` *Standard keys*. Google is retiring Standard keys during 2026. Auth keys **must be sent in the `x-goog-api-key` HTTP header**. Sending them as a `?key=` URL parameter fails with a 404, which breaks many older integrations.

Pointer handles this correctly:

- Every Gemini request sends the key in the `x-goog-api-key` header and never in the URL.
- Key validation accepts both `AQ.` and `AIza` formats (the dot is part of the key). An unfamiliar format only triggers a warning, so a future format change can't lock you out.
- Pasted keys are cleaned up: surrounding whitespace, quotes and `GEMINI_API_KEY=` prefixes are removed.
- The Gemini 3 *thought signatures* and function-call IDs are sent back exactly as the API returned them, as tool calling requires.

Keys are encrypted with the operating system's secure storage (DPAPI on Windows, Keychain on macOS, libsecret on Linux). Pointer also reads `GEMINI_API_KEY`, `GOOGLE_API_KEY` and `GROQ_API_KEY` from the environment.

Model lists come live from both APIs, so new models show up automatically. The defaults are Gemini 3 Flash for chat and the agent, and Groq `openai/gpt-oss-20b` for autocomplete.

## Download / install (Windows)

Run `Pointer-Setup-1.0.0.exe` (installer with Start-menu and desktop shortcuts), or use `Pointer-1.0.0-portable.exe` (no install).

The builds are not code-signed, so Windows SmartScreen may warn on first launch. Click **More info → Run anyway**.

## Building from source

Requirements: Node.js 20+ and npm.

```bash
npm install
npm start            # build the UI and launch Pointer
npm run dev          # hot-reload development mode
npm run dist:win     # Windows installer + portable .exe  → release/
npm run dist:mac     # macOS .dmg
npm run dist:linux   # Linux AppImage
```

Building the Windows `.exe` on Linux or macOS requires [Wine](https://www.winehq.org/), which is used to stamp the icon and version info into the executable. `scripts/prepare-win.js` downloads the prebuilt Windows terminal (node-pty) binaries automatically.

The **Build** GitHub Actions workflow (`.github/workflows/build.yml`) builds the Windows installer on a Windows runner. Pushing a tag like `v1.0.0` publishes a GitHub release with the `.exe` files attached.

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Open agent / chat | Ctrl+I |
| Inline AI edit | Ctrl+K (in the editor) |
| Add selection to chat | Ctrl+L |
| New chat | Ctrl+Shift+L |
| Go to file | Ctrl+P |
| Command palette | Ctrl+Shift+P / F1 |
| Search in files | Ctrl+Shift+F |
| Toggle terminal | Ctrl+J or Ctrl+\` |
| Toggle sidebar / AI pane | Ctrl+B / Ctrl+Alt+B |
| Save / Save all | Ctrl+S / Ctrl+Alt+S |
| Settings | Ctrl+, |

## Project layout

```
electron/            main process (Node.js)
  main.mjs           window, app:// protocol, IPC wiring
  settings.mjs       settings + encrypted API keys (AQ./AIza/gsk_ handling)
  fsService.mjs      file system, watcher, search
  terminal.mjs       integrated terminal (node-pty)
  shell.mjs          shell detection, PowerShell 5 `&&` translation
  agent/
    providers.mjs    Gemini (native REST, x-goog-api-key) + Groq (OpenAI-compatible)
    tools.mjs        the agent's tools (real fs + shell) and undo checkpoints
    agent.mjs        agent loop, approvals, inline edit, autocomplete
    prompts.mjs      system prompt + context building
  preload.cjs        safe bridge to the UI
src/                 renderer (React + Monaco + xterm.js)
```

## License

MIT
