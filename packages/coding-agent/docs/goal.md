# Goals

The goal extension gives Pi a Codex-style persistent goal: set an objective once, and the agent keeps working toward it across turns until it is completed, blocked, or paused.

The goal is built in and always available. State is persisted in the session as custom entries, so it survives restarts and resumes on the current session branch like any other conversation state.

## Commands

| Command | Description |
| ------- | ----------- |
| `/goal` | Show the current goal, status, and time used. |
| `/goal <objective>` | Create a new goal (or replace an unfinished one after confirmation). |
| `/goal pause` | Pause the goal and stop auto-continuation. |
| `/goal resume` | Resume a paused or blocked goal. |
| `/goal clear` | Clear the goal entirely. |
| `/goal edit [<objective>]` | Change the objective. |

## How it works

- **Hidden context**: before each round, the extension injects a hidden custom message with the objective, status, and time used. The objective is treated as user-provided data; it is never added to the system prompt.
- **Auto-continuation**: after the agent fully settles (`agent_settled`) - when the goal is active, the agent is idle, there are no queued messages, and the run was not aborted - a hidden continuation message triggers the next round. Commands that activate a goal (`/goal <objective>`, `/goal resume`) start the first round immediately when the agent is idle; while streaming or when messages are queued they skip and let the settle path schedule the continuation. Duplicate scheduling is prevented, and the continuation is checked against the latest goal revision so pausing, clearing, or replacing the goal stops old work immediately.
- **Time accounting**: each finished turn accrues the running time toward the goal, including the turn that marks the goal `complete` or `blocked` (the tool call happens before `turn_end`, so the state flip does not drop that turn's time). No token or resource budgets are enforced.

## Tools

The LLM can manage the goal through three tools:

- `get_goal` - read the current goal (objective, status, time used).
- `create_goal` - only used when the user explicitly asks to start a new goal. Refuses to replace an unfinished goal unless `overwrite=true`. Following Codex semantics, `active`, `paused`, and `blocked` goals are all unfinished - only a `complete` goal can be replaced without confirmation.
- `update_goal` - marks the goal `complete` (objective fully achieved) or `blocked` (cannot proceed, e.g. missing credentials or an external dependency). Both stop auto-continuation.

## Notes

- Goal state is stored in session custom entries. Because entries do not participate in the LLM context, the objective is only re-injected each round as a hidden custom message.
- Forking, resuming, and compacting a session preserve the latest goal state on the active branch.
- In print mode (`-p`), `/goal` prints the summary to stdout instead of showing a notification.