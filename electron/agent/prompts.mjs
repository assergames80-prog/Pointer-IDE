import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { detectShell } from '../shell.mjs';

const RULE_FILES = ['.pointerrules', '.cursorrules', 'AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md'];

function readRules(root) {
  if (!root) return '';
  const out = [];
  for (const f of RULE_FILES) {
    try {
      const p = path.join(root, f);
      if (fs.statSync(p).isFile()) {
        const text = fs.readFileSync(p, 'utf8').trim();
        if (text) out.push(`<rules file="${f}">\n${text.slice(0, 12000)}\n</rules>`);
      }
    } catch {}
  }
  return out.join('\n');
}

function osName() {
  if (process.platform === 'win32') return `Windows ${os.release()}`;
  if (process.platform === 'darwin') return `macOS ${os.release()}`;
  return `Linux ${os.release()}`;
}

function shellGuidance() {
  const sh = detectShell();
  if (sh.kind === 'powershell') {
    return `Commands run in ${sh.name}. Use PowerShell syntax (e.g. Get-ChildItem, Remove-Item -Recurse -Force, $env:VAR="x"). Chain commands with ";" (\`&&\` is translated automatically). Prefer cross-platform tools (node, npm, git, python).`;
  }
  if (sh.kind === 'pwsh') {
    return `Commands run in ${sh.name}. Use PowerShell syntax (e.g. Get-ChildItem, Remove-Item -Recurse -Force, $env:VAR="x"); \`&&\` and \`||\` work.`;
  }
  if (sh.kind === 'cmd') return `Commands run in cmd.exe. Use cmd syntax.`;
  return `Commands run in ${sh.name} (login shell).`;
}

export function buildSystemPrompt({ root, mode, settings, context }) {
  const now = new Date();
  const parts = [];
  parts.push(
    `You are Pointer, an expert AI software engineer working inside the Pointer code editor. You pair-program with the user on their codebase.`,
  );
  if (mode === 'agent') {
    parts.push(`You are running in AGENT mode. You operate directly on the user's real computer — your tools read and write real files and execute real commands in a real shell. There is no sandbox, so act deliberately, but act: complete the task end-to-end instead of describing what the user should do.

<agent_workflow>
1. Understand the request. If the workspace is unfamiliar, explore first (list_dir, find_files, search_text, read_file).
2. Make the changes with tools. Read a file before editing it. Use edit_file for targeted edits (exact old_string, unique, with enough context) and write_file for new files or full rewrites.
3. Verify: run builds, tests, linters or the program itself with run_command when it makes sense, read the output, and fix problems. Iterate until the task is actually done.
4. Finish with a short summary of what you changed and anything the user must do next. Do not paste whole files you already wrote.
</agent_workflow>

<rules>
- Keep going until the task is complete; do not stop to ask for permission for routine steps. Only ask the user when a decision is genuinely ambiguous or risky.
- Never print code in your reply that you intend to apply — apply it with the tools instead.
- Match the existing code style, structure and libraries. Keep changes focused on the request.
- Commands must be non-interactive: use flags like --yes / -y, avoid editors and pagers. Start servers and watchers with run_command(background: true), then check them with process_control.
- Do not run destructive commands (deleting data, force-pushing, dropping databases, formatting disks) unless the user explicitly asked for it.
- If a tool returns an error, read it carefully and adjust (e.g. re-read the file before retrying an edit). Don't repeat the exact same failing call.
- Call independent read-only tools in parallel when you can.
</rules>`);
  } else {
    parts.push(`You are running in ASK mode: you can explore the code with read-only tools (list_dir, read_file, search_text, find_files, web_fetch) but you cannot modify files or run commands. Answer questions, explain code, and propose changes as fenced code blocks with the language and file path, e.g. \`\`\`ts src/app.ts. If the user wants the change applied, tell them to switch to Agent mode.`);
  }
  parts.push(`<environment>
Operating system: ${osName()} (${process.platform} ${process.arch})
${shellGuidance()}
Workspace root: ${root || '(no folder open — use absolute paths)'}
Home directory: ${os.homedir()}
Current date: ${now.toISOString().slice(0, 10)}
Relative paths in tool calls are resolved against the workspace root.
</environment>`);

  if (context?.openFiles?.length) {
    parts.push(`<open_editors>\n${context.openFiles.slice(0, 20).join('\n')}\n</open_editors>`);
  }
  parts.push(`<formatting>
Reply in GitHub-flavored Markdown. Refer to files with backticks, e.g. \`src/index.js\`. Use fenced code blocks with a language tag. Be concise and direct.
</formatting>`);
  const rules = readRules(root);
  if (rules) parts.push(`The project contains instruction files. Follow them:\n${rules}`);
  if (settings.customInstructions?.trim()) {
    parts.push(`<user_instructions>\n${settings.customInstructions.trim()}\n</user_instructions>`);
  }
  return parts.join('\n\n');
}

/** Expands the user's message with attached context (current file, selection, @-mentioned files). */
export function expandUserMessage(text, context, root, readFile) {
  const blocks = [];
  if (context?.selection?.text) {
    const s = context.selection;
    blocks.push(
      `<selected_code file="${s.path}" lines="${s.startLine}-${s.endLine}">\n${s.text.slice(0, 40000)}\n</selected_code>`,
    );
  }
  for (const f of context?.files || []) {
    const content = readFile(f);
    if (content == null) continue;
    const rel = root && f.startsWith(root) ? path.relative(root, f).split(path.sep).join('/') : f;
    const lines = content.split(/\r?\n/);
    const clipped = lines.length > 1200 ? lines.slice(0, 1200).join('\n') + `\n… (${lines.length - 1200} more lines — use read_file)` : content;
    blocks.push(`<attached_file path="${rel}">\n${clipped}\n</attached_file>`);
  }
  if (context?.activeFile && !(context.files || []).includes(context.activeFile)) {
    const a = context.activeFile;
    const rel = root && a.startsWith(root) ? path.relative(root, a).split(path.sep).join('/') : a;
    blocks.push(
      `<current_file path="${rel}"${context.cursorLine ? ` cursor_line="${context.cursorLine}"` : ''}>The user is currently viewing this file. Read it with read_file if relevant.</current_file>`,
    );
  }
  if (!blocks.length) return text;
  return `${blocks.join('\n\n')}\n\n<user_query>\n${text}\n</user_query>`;
}
