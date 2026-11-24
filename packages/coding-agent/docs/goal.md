# Goals

The goal extension gives Pi a Codex-style persistent goal: set an objective once, and the agent keeps working toward it across rounds until it is completed, blocked, paused, or aborted.

The goal extension is built in and always available. State is persisted in the session as custom entries, so it survives restarts and resumes on the current session branch like any other conversation state.

## Commands

| Command | Description |
| ------- | ----------- |
| `/goal` (or `/goal show`, `/goal status`) | Show the current goal, status, rounds, and active time used. |
| `/goal <objective>` | Create a new goal (or replace an unfinished one after confirmation). |
| `/goal set <objective>` | Explicit alias for creating a goal (useful when the objective starts with a subcommand keyword). |
| `/goal pause` | Pause the goal and stop auto-continuation. |
| `/goal resume` | Resume a paused or blocked goal (or kick off a restored idle active goal). |
| `/goal clear` | Clear the goal entirely. |
| `/goal edit [<objective>]` | Update the objective (opens an editor when omitted in interactive UI). |

Zero-argument subcommands (`show`, `status`, `pause`, `resume`, `clear`) match only when given with no trailing text, so natural-language objectives like `/goal clear unused imports` create a goal instead of running `clear`.

## How it works

- **Hidden context**: on `before_agent_start`, the extension injects a hidden custom message with the objective, goal ID, status, and active time used whenever the goal state is new, edited, restored, or compacted (`session_compact`). The objective is treated as user-provided data and is never added to the system prompt.
- **Auto-continuation (`agent_before_settle`)**: when a round finishes cleanly (`outcome === "completed"`) with an active goal, no queued messages, and no prior continuation, the extension appends a continuation message and keeps the run going in the same session loop. Aborted runs (Escape) skip `agent_before_settle` automatically; errored runs stop without continuing. Subsequent rounds send compact reminders without duplicating the full objective unless compaction or an edit requires re-injection.
- **Idle-loop protection**: if 3 consecutive rounds finish with no non-goal tool calls, the goal auto-pauses and notifies the user so forgotten completion calls cannot spin indefinitely.
- **Active run time accounting**: `timeUsedMs` counts wall-clock time spent inside agent runs while the goal is active (not idle time between sessions or while waiting on the user), including the turn that marks the goal `complete` or `blocked`. No token or resource budgets are enforced.
- **Branch navigation**: restoring a session (`session_start`) or switching branches (`/tree`) restores the branch's latest goal without auto-starting LLM work; run `/goal resume` or send a message to continue.

## Tool

The LLM manages the goal through a single `goal` tool with an `action` parameter:

- `action="get"` - read the current goal (objective, status, rounds, live active time used), or `null` when none is set.
- `action="create"` - start a new goal (`objective`, optional `overwrite=true`). Only used when the user explicitly asks to start a new goal. Refuses to replace an unfinished (`active`, `paused`, or `blocked`) goal unless `overwrite=true`.
- `action="complete"` - mark the active goal complete (`goalId`, optional `note`) once fully achieved and verified. Stops auto-continuation.
- `action="blocked"` - mark the active goal blocked (`goalId`, optional `note`) when unable to proceed. Stops auto-continuation.

## Notes

- Goal state is stored in session custom entries (`goal`). Continuation rounds are rendered as compact transcript banners that can be expanded to inspect the full prompt.
- In print and JSON modes (`-p`, `--mode json`), `/goal` prints the summary to stdout, and `/goal <objective>` / `/goal resume` wait for the goal run to finish before exiting.
