# Inline todo lists

Pi includes a persistent inline todo list for tracking multi-step work. The list is rendered above the editor: new items start with an empty `☐` box, completed items become `☑` and are crossed out, and the panel changes to `TODO DONE` when every item is complete.

## Commands

| Command | Description |
| ------- | ----------- |
| `/todo` | Show the current list in a notification. |
| `/todo clear` | Clear the current list after confirmation. |

## Tools

The agent can manage the list with four built-in tools:

- `get_todos` - read the current list and its stable `listId`/`itemId` values.
- `create_todo_list` - create an ordered list. This is intended for explicit todo requests or when the user asks to track a multi-step task.
- `add_todo_item` - append an unchecked item to the current list.
- `update_todo_item` - mark an item `complete` after the work is completed and verified, or return it to `pending`.

The list is persisted as session custom entries and follows the active session branch across restarts, forks, and tree navigation. The widget is updated only when its rendered state changes; ordinary turns do not repeatedly repaint the todo panel.
