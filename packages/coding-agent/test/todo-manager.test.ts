import { describe, expect, it, vi } from "vitest";
import { TodoManager } from "../src/extensions/todo/manager.ts";

function setup() {
	const persisted: unknown[] = [];
	const changed = vi.fn();
	const notify = vi.fn();
	let now = 1000;
	const manager = new TodoManager({
		persist: (entry) => persisted.push(entry),
		notify,
		onStateChange: changed,
		now: () => now,
	});
	return {
		manager,
		persisted,
		changed,
		notify,
		setNow: (value: number) => {
			now = value;
		},
	};
}

describe("TodoManager", () => {
	it("creates an unchecked list and persists each state change", () => {
		const h = setup();
		expect(h.manager.create(["One", "Two"])).toBe("created");
		const state = h.manager.getState()!;
		expect(state.items.every((item) => !item.done)).toBe(true);
		expect(h.persisted).toHaveLength(1);
		expect(h.changed).toHaveBeenCalledTimes(1);
	});

	it("refuses to replace an unfinished list without overwrite", () => {
		const h = setup();
		h.manager.create(["One"]);
		expect(h.manager.create(["Two"])).toBe("refused");
		expect(h.manager.getState()!.items[0]!.text).toBe("One");
	});

	it("updates a task and reports the completed list", () => {
		const h = setup();
		h.manager.create(["One"]);
		const state = h.manager.getState()!;
		h.setNow(2000);
		expect(h.manager.update(state.items[0]!.id, "complete", state.listId)).toBe("updated");
		expect(h.manager.getState()!.items[0]!.done).toBe(true);
		expect(h.notify).toHaveBeenCalledWith("All todos complete.", "info");
	});

	it("rejects stale list IDs and clears with a tombstone", async () => {
		const h = setup();
		h.manager.create(["One"]);
		expect(h.manager.update("item", "complete", "wrong-list")).toBe("noop");
		expect(await h.manager.clear(async () => false)).toBe("refused");
		expect(await h.manager.clear(async () => true)).toBe("cleared");
		expect(h.manager.getState()).toBeNull();
		expect(h.persisted.at(-1)).toMatchObject({ status: "cleared" });
	});
});
