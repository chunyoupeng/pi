import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionUIContext, UIPromptEndEvent, UIPromptStartEvent } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";

import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

type RecordedEvent = UIPromptStartEvent | UIPromptEndEvent;

interface TestGlobals {
	events: RecordedEvent[];
	startGate?: Promise<void>;
	selectImpl?: (title: string, options: string[]) => Promise<string | undefined>;
	confirmImpl?: (title: string, message: string) => Promise<boolean>;
}

declare global {
	// eslint-disable-next-line no-var
	var __uiPromptTest: TestGlobals | undefined;
}

const EXTENSION_CODE = `
	export default function(pi) {
		pi.on("ui_prompt_start", async (event) => {
			const gate = globalThis.__uiPromptTest.startGate;
			if (gate) await gate;
			globalThis.__uiPromptTest.events.push({
				type: "ui_prompt_start",
				reason: event.reason,
				kind: event.kind,
				...(event.title !== undefined ? { title: event.title } : {}),
			});
		});
		pi.on("ui_prompt_end", async (event) => {
			const gate = globalThis.__uiPromptTest.startGate;
			if (gate) await gate;
			globalThis.__uiPromptTest.events.push({
				type: "ui_prompt_end",
				reason: event.reason,
				kind: event.kind,
				...(event.title !== undefined ? { title: event.title } : {}),
			});
		});
	}
`;

function flushEvents(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 10));
}

function testGlobals(): TestGlobals {
	return (globalThis as { __uiPromptTest: TestGlobals }).__uiPromptTest;
}

describe("ui prompt events", () => {
	let tempDir: string;
	let runner: ExtensionRunner;
	let events: RecordedEvent[];
	let uiContext: ExtensionUIContext;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ui-prompt-test-"));
		const extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
		fs.writeFileSync(path.join(extensionsDir, "record.ts"), EXTENSION_CODE);

		events = [];
		(globalThis as Record<string, unknown>).__uiPromptTest = { events };

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		const sessionManager = SessionManager.inMemory();
		const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

		runner.setUIContext(
			{
				select: (title, options) => {
					const impl = testGlobals().selectImpl;
					return impl ? impl(title, options) : Promise.resolve(undefined);
				},
				confirm: (title, message) => {
					const impl = testGlobals().confirmImpl;
					return impl ? impl(title, message) : Promise.resolve(false);
				},
			} as ExtensionUIContext,
			"rpc",
		);
		uiContext = runner.getUIContext();
	});

	afterEach(() => {
		delete (globalThis as Record<string, unknown>).__uiPromptTest;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("emits start and end around a ctx.ui.select prompt", async () => {
		let resolveSelect: (value: string | undefined) => void = () => {};
		testGlobals().selectImpl = () =>
			new Promise((resolve) => {
				resolveSelect = resolve;
			});

		const pending = uiContext.select("Pick one", ["a", "b"]);
		await flushEvents();

		expect(events).toEqual([{ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "Pick one" }]);

		resolveSelect("a");
		await expect(pending).resolves.toBe("a");
		await flushEvents();

		expect(events).toEqual([
			{ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "Pick one" },
			{ type: "ui_prompt_end", reason: "ui_prompt", kind: "select", title: "Pick one" },
		]);
	});

	it("emits start and end even when the prompt throws", async () => {
		testGlobals().selectImpl = () => Promise.reject(new Error("boom"));

		await expect(uiContext.select("Pick one", ["a"])).rejects.toThrow("boom");
		await flushEvents();

		expect(events).toEqual([
			{ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "Pick one" },
			{ type: "ui_prompt_end", reason: "ui_prompt", kind: "select", title: "Pick one" },
		]);
	});

	it("coalesces nested prompts into one outer waiting span", async () => {
		let resolveConfirm: (value: boolean) => void = () => {};
		testGlobals().confirmImpl = () =>
			new Promise((resolve) => {
				resolveConfirm = resolve;
			});
		testGlobals().selectImpl = async () => {
			await uiContext.confirm("Inner", "continue?");
			return "a";
		};

		const pending = uiContext.select("Outer", ["a", "b"]);
		await flushEvents();

		// Nested confirm must not add another start event.
		expect(events).toEqual([{ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "Outer" }]);

		resolveConfirm(true);
		await expect(pending).resolves.toBe("a");
		await flushEvents();

		// One end event for the whole coalesced span, describing the outer prompt.
		expect(events).toEqual([
			{ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "Outer" },
			{ type: "ui_prompt_end", reason: "ui_prompt", kind: "select", title: "Outer" },
		]);
	});

	it("does not delay the prompt while handlers run", async () => {
		let resolveGate: () => void = () => {};
		testGlobals().startGate = new Promise((resolve) => {
			resolveGate = resolve;
		});
		testGlobals().selectImpl = () => Promise.resolve("a");

		// The select prompt resolves even though the ui_prompt_start handler is
		// still blocked behind the gate.
		await expect(uiContext.select("Pick one", ["a"])).resolves.toBe("a");
		expect(events).toEqual([]);

		resolveGate();
		await flushEvents();
		expect(events.map((e) => e.type)).toEqual(["ui_prompt_start", "ui_prompt_end"]);
	});

	it("does not emit events when no UI context is set", async () => {
		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const bareRunner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			tempDir,
			SessionManager.inMemory(),
			modelRegistry,
		);

		const context = bareRunner.getUIContext();
		await expect(context.select("Pick one", ["a"])).resolves.toBeUndefined();
		await flushEvents();

		expect(events).toEqual([]);
		expect(bareRunner.hasUI()).toBe(false);
	});
});
