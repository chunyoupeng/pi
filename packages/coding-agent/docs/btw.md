# Side Questions (/btw)

Pi includes a built-in `/btw` extension for asking side questions in a dedicated fullscreen interface without interrupting active agent runs or polluting the main conversation history.

## Commands

| Command | Description |
| ------- | ----------- |
| `/btw [question]` | Open the fullscreen side conversation UI, optionally submitting an initial question. |
| `/btw cancel` | Cancel an in-progress side question stream. |
| `/btw clear` | Clear side conversation state and thread history. |

## Fullscreen Conversation UI

- **Main window aesthetic**: Features native header, border styling, status badges, and message formatting identical to the main session interface.
- **Native components**: Reuses `UserMessageComponent` (with prompt prefix `❯ ` and theme styling) and `AssistantMessageComponent` (with collapsible thinking blocks and syntax-highlighted Markdown).
- **Scrollable transcript**: Review all earlier turns in the continuous side thread with standard page navigation keybindings (`PageUp` / `PageDown`).
- **Multiline editor**: Enter multi-turn side questions directly in the view using the bottom editor (`Enter` to submit, `Shift+Enter` for newlines).
- **Safe queueing**: Submitting while the model is actively streaming queues the question to run once the current turn completes, preventing stream corruption.

## Keybindings & Controls

| Action | Default Key | App Keybinding | Description |
| ------ | ----------- | -------------- | ----------- |
| Cancel stream | `Ctrl+C` | `app.btw.cancel` | Cancels **only** the active side question stream. The main task and session are never aborted. When idle, clears editor input. |
| Return to main | `Esc` | `app.btw.close` | Closes the side view and returns to the main conversation. Ongoing requests are aborted on exit. |
| Submit question | `Enter` | `tui.input.submit` | Submits the current question to the side thread. |
| Insert newline | `Shift+Enter` | `tui.input.newLine` | Inserts a newline in the multiline editor. |
| Scroll transcript | `PageUp` / `PageDown` | `tui.altScreen.pageUp` / `tui.altScreen.pageDown` | Scrolls the conversation transcript up and down. |

Keybindings can be customized in `~/.pi/agent/keybindings.json` using the standard keybinding actions above.

### Cancellation on Exit to Avoid Hidden Costs

When you press `Esc` (or close the view) while a side question is actively streaming, Pi automatically cancels the active stream. This prevents invisible background paid model calls and unexpected token costs. Any partial response received prior to closing is preserved with a cancellation notice in the thread history.

### Reopening & Retained History

Side conversation history is retained in memory for the duration of your session. When you reopen `/btw`, all prior turns remain visible in the scrollable transcript, allowing you to ask follow-up questions in the same continuous context.

## Independent Execution & Context

- **Current model & credentials**: Runs using the active session model (`ctx.model`) and its resolved provider authentication snapshot.
- **Context snapshot**: Extracts a compacted plaintext snapshot of the active main branch (up to 40,000 characters) to provide background for the side question.
- **Tool-free**: Runs without tools (`read`, `write`, `edit`, `bash`, etc.), preventing accidental file modifications or command execution.
- **Main session isolation**: Neither questions nor answers are added to the main LLM context or written to session JSONL history files. Side questions never interrupt, block, or abort active main agent runs.
- **Automatic lifecycle cleanup**: State and memory are automatically cleared on session replacement (`session_start`), session tree navigation (`session_tree`), or session shutdown (`session_shutdown`).

## External `@narumitw/pi-btw` Package Collision

If you previously installed the third-party `@narumitw/pi-btw` package, both the built-in extension and the package register the `/btw` command. Pi retains both and assigns numeric invocation suffixes (e.g. `/btw:1` and `/btw:2`).

To use the built-in command cleanly without collision, disable the external package first using `pi config` (switch to the package and disable its extension), or uninstall it:

```bash
pi remove npm:@narumitw/pi-btw
```
