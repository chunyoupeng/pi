/**
 * Unit and real AgentSession + faux provider integration tests for workspace switching:
 * - workspaceSwitchPolicy & symlink-safe containment checks
 * - same-turn sequential switch_workspace + read/bash execution
 * - incremental <cwd> and <project_context> (AGENTS.md) system prompt diffing via DefaultResourceLoader
 * - SessionManager cwd_change persistence, resume, cwdOverride, and tree navigation restore
 * - /cd command (including /cd -) and memory extension <project_memory> refresh
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import memoryExtension from "../../src/extensions/memory/index.ts";
import workspaceExtension from "../../src/extensions/workspace/index.ts";
import { evaluateSwitchDecision } from "../../src/extensions/workspace/policy.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

describe("workspace switching policy", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("evaluates off, allow, ask, and workspace containment including symlink escapes", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-ws-policy-"));
		tempDirs.push(root);
		const initialCwd = join(root, "workspace");
		const subProject = join(initialCwd, "proj-a");
		const outside = join(root, "outside");
		const allowedExtra = join(root, "allowed-extra");
		const symlinkEscape = join(initialCwd, "escape-link");
		mkdirSync(subProject, { recursive: true });
		mkdirSync(outside, { recursive: true });
		mkdirSync(allowedExtra, { recursive: true });
		symlinkSync(outside, symlinkEscape);

		expect(
			evaluateSwitchDecision({
				policy: "off",
				targetCwd: subProject,
				initialCwd,
				allowedWorkspaces: [],
			}).kind,
		).toBe("deny");

		expect(
			evaluateSwitchDecision({
				policy: "allow",
				targetCwd: outside,
				initialCwd,
				allowedWorkspaces: [],
			}).kind,
		).toBe("allow");

		expect(
			evaluateSwitchDecision({
				policy: "ask",
				targetCwd: subProject,
				initialCwd,
				allowedWorkspaces: [],
			}).kind,
		).toBe("confirm");

		expect(
			evaluateSwitchDecision({
				policy: "workspace",
				targetCwd: subProject,
				initialCwd,
				allowedWorkspaces: [],
			}).kind,
		).toBe("allow");

		expect(
			evaluateSwitchDecision({
				policy: "workspace",
				targetCwd: outside,
				initialCwd,
				allowedWorkspaces: [],
			}).kind,
		).toBe("confirm");

		expect(
			evaluateSwitchDecision({
				policy: "workspace",
				targetCwd: allowedExtra,
				initialCwd,
				allowedWorkspaces: [allowedExtra],
			}).kind,
		).toBe("allow");

		// Symlink inside workspace pointing outside must require confirmation.
		expect(
			evaluateSwitchDecision({
				policy: "workspace",
				targetCwd: symlinkEscape,
				initialCwd,
				allowedWorkspaces: [],
			}).kind,
		).toBe("confirm");
	});
});

describe("workspace extension with real AgentSession", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("switches cwd mid-turn sequentially so read, bash, and next-turn system prompt use the new project", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-ws-agent-"));
		tempDirs.push(agentDir);
		const placeholderCwd = mkdtempSync(join(tmpdir(), "pi-ws-placeholder-"));
		tempDirs.push(placeholderCwd);

		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: placeholderCwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			extensionFactories: [workspaceExtension],
		});
		await resourceLoader.reload();

		const harness = await createHarness({
			resourceLoader,
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });

		// Create sub-project inside the harness's initial cwd (tempDir)
		const workspaceRoot = harness.tempDir;
		const projB = join(workspaceRoot, "proj-b");
		mkdirSync(projB, { recursive: true });
		writeFileSync(join(workspaceRoot, "hello.txt"), "from-root", "utf8");
		writeFileSync(join(projB, "hello.txt"), "from-proj-b", "utf8");
		writeFileSync(join(projB, "AGENTS.md"), "PROJECT_B_RULE_MARKER", "utf8");

		let nextTurnSystemPromptText = "";
		let sawReadResult = "";
		let sawPwdResult = "";

		harness.setResponses([
			// Turn 1: emit switch_workspace AND read in the same assistant response.
			// executionMode: "sequential" ensures switch_workspace finishes before read runs.
			fauxAssistantMessage([
				fauxToolCall("switch_workspace", { path: "proj-b", reason: "work inside proj-b" }),
				fauxToolCall("read", { path: "hello.txt" }),
			]),
			// Turn 2: inspect updated system prompt sections and run bash pwd in the new cwd.
			(context) => {
				const sys = getCurrentSystemMessage(context.messages);
				nextTurnSystemPromptText = Object.values(sys?.sections ?? {}).join("\n");
				const toolResults = context.messages.filter((m) => m.role === "toolResult");
				const readMsg = toolResults.find((m) => m.toolName === "read");
				sawReadResult = readMsg?.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
				return fauxAssistantMessage([fauxToolCall("bash", { command: "pwd -P" })]);
			},
			(context) => {
				const bashMsg = context.messages.filter((m) => m.role === "toolResult").find((m) => m.toolName === "bash");
				sawPwdResult =
					bashMsg?.content
						.map((c) => (c.type === "text" ? c.text : ""))
						.join("")
						.trim() ?? "";
				return fauxAssistantMessage("Done in proj-b.");
			},
		]);

		await harness.session.prompt("Switch to proj-b and inspect hello.txt");
		await harness.session.waitForIdle();

		expect(harness.session.cwd).toBe(projB);
		expect(harness.sessionManager.getCwd()).toBe(projB);
		expect(sawReadResult).toContain("from-proj-b");
		expect(sawPwdResult).toBe(realpathSync(projB));
		expect(nextTurnSystemPromptText).toContain(projB.replace(/\\/g, "/"));
		expect(nextTurnSystemPromptText).toContain("PROJECT_B_RULE_MARKER");

		const cwdEvents = harness.eventsOfType("cwd_changed");
		expect(cwdEvents).toHaveLength(1);
		expect(cwdEvents[0]?.previousCwd).toBe(workspaceRoot);
		expect(cwdEvents[0]?.cwd).toBe(projB);
	});

	it("persists cwd_change across SessionManager.open, respects cwdOverride, and restores cwd on navigateTree", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-ws-sessions-"));
		tempDirs.push(sessionDir);

		// Start harness, then create persisted SessionManager rooted at a dedicated workspace directory
		const workspaceRoot = mkdtempSync(join(tmpdir(), "pi-ws-persist-"));
		tempDirs.push(workspaceRoot);
		const projA = join(workspaceRoot, "proj-a");
		mkdirSync(projA, { recursive: true });

		const sessionManager = SessionManager.create(workspaceRoot, sessionDir);
		const harness = await createHarness({
			sessionManager,
			settings: { workspaceSwitchPolicy: "allow" },
			extensionFactories: [workspaceExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });
		await harness.session.setCwd(workspaceRoot, { recordInSession: false });

		harness.setResponses([
			fauxAssistantMessage("First reply in root."),
			fauxAssistantMessage([fauxToolCall("switch_workspace", { path: "proj-a" })]),
			fauxAssistantMessage("Second reply in proj-a."),
		]);

		await harness.session.prompt("Turn 1 in root");
		await harness.session.waitForIdle();
		const firstLeafId = harness.sessionManager.getLeafId()!;

		await harness.session.prompt("Turn 2 switch to proj-a");
		await harness.session.waitForIdle();

		expect(harness.session.cwd).toBe(projA);
		const sessionFile = harness.sessionManager.getSessionFile()!;
		expect(sessionFile).toBeTruthy();

		// Re-opening restores latest cwd_change from the persisted branch.
		const reopened = SessionManager.open(sessionFile);
		expect(reopened.getCwd()).toBe(projA);

		// Explicit cwdOverride wins until a new cwd_change is appended.
		const overridden = SessionManager.open(sessionFile, undefined, workspaceRoot);
		expect(overridden.getCwd()).toBe(workspaceRoot);

		// Navigating back to the earlier leaf restores the root cwd.
		const nav = await harness.session.navigateTree(firstLeafId);
		expect(nav.cancelled).toBe(false);
		expect(harness.session.cwd).toBe(workspaceRoot);
		expect(harness.sessionManager.getCwd()).toBe(workspaceRoot);
	});

	it("confirms or declines switches outside initial workspace and supports /cd and /cd -", async () => {
		const outside = mkdtempSync(join(tmpdir(), "pi-ws-outside-"));
		tempDirs.push(outside);

		let confirmAnswer = false;
		const confirmCalls: string[] = [];
		const harness = await createHarness({
			extensionFactories: [workspaceExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				confirm: async (title, message) => {
					confirmCalls.push(`${title}: ${message}`);
					return confirmAnswer;
				},
			}),
			mode: "tui",
		});

		const initialCwd = harness.tempDir;

		// Declined switch keeps original cwd.
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("switch_workspace", { path: outside, reason: "check sibling" })]),
			fauxAssistantMessage("Okay, staying put."),
		]);
		await harness.session.prompt("Try switching outside");
		await harness.session.waitForIdle();
		expect(confirmCalls).toHaveLength(1);
		expect(harness.session.cwd).toBe(initialCwd);

		// Approved switch updates cwd.
		confirmAnswer = true;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("switch_workspace", { path: outside })]),
			fauxAssistantMessage("Switched to outside."),
		]);
		await harness.session.prompt("Switch outside again");
		await harness.session.waitForIdle();
		expect(confirmCalls).toHaveLength(2);
		expect(harness.session.cwd).toBe(outside);

		// Manual /cd - switches back to previous cwd without confirmation.
		await harness.session.prompt("/cd -");
		await harness.session.waitForIdle();
		expect(harness.session.cwd).toBe(initialCwd);
		expect(confirmCalls).toHaveLength(2);
	});

	it("blocks agent switch_workspace when policy is off while allowing manual /cd", async () => {
		const harness = await createHarness({
			settings: { workspaceSwitchPolicy: "off" },
			extensionFactories: [workspaceExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });

		const subDir = join(harness.tempDir, "sub");
		mkdirSync(subDir, { recursive: true });

		let switchErrorText = "";
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("switch_workspace", { path: "sub" })]),
			(context) => {
				const result = context.messages
					.filter((m) => m.role === "toolResult")
					.find((m) => m.toolName === "switch_workspace");
				switchErrorText = result?.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
				return fauxAssistantMessage("Disabled.");
			},
		]);

		await harness.session.prompt("Switch to sub");
		await harness.session.waitForIdle();
		expect(harness.session.cwd).toBe(harness.tempDir);
		expect(switchErrorText).toContain("disabled");

		// Manual /cd still works even when workspaceSwitchPolicy is "off".
		await harness.session.prompt("/cd sub");
		await harness.session.waitForIdle();
		expect(harness.session.cwd).toBe(subDir);
	});

	it("refreshes <project_memory> mid-run when switching workspaces with memory extension loaded", async () => {
		const harness = await createHarness({
			extensionFactories: [workspaceExtension, memoryExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext(), mode: "tui" });

		const projA = join(harness.tempDir, "proj-a");
		const projB = join(harness.tempDir, "proj-b");
		mkdirSync(projA, { recursive: true });
		mkdirSync(projB, { recursive: true });

		let turn2ProjectMemorySection = "";
		harness.setResponses([
			fauxAssistantMessage([
				fauxToolCall("switch_workspace", { path: "proj-b" }),
				fauxToolCall("memory", {
					action: "add",
					scope: "project",
					id: "proj-b-fact",
					category: "fact",
					title: "PROJ_B_UNIQUE_MEMORY_TITLE",
					body: "stored inside proj-b",
				}),
			]),
			fauxAssistantMessage("Saved proj-b memory."),
			// Switch to proj-a, then back to proj-b, and verify <project_memory> reflects proj-b mid-run.
			fauxAssistantMessage([fauxToolCall("switch_workspace", { path: projA })]),
			fauxAssistantMessage("In proj-a."),
			fauxAssistantMessage([fauxToolCall("switch_workspace", { path: projB })]),
			(context) => {
				const sys = getCurrentSystemMessage(context.messages);
				turn2ProjectMemorySection = sys?.sections?.project_memory ?? "";
				return fauxAssistantMessage("Back in proj-b.");
			},
		]);

		await harness.session.prompt("Record a fact in proj-b");
		await harness.session.waitForIdle();
		await harness.session.prompt("Go to proj-a");
		await harness.session.waitForIdle();
		await harness.session.prompt("Return to proj-b");
		await harness.session.waitForIdle();

		expect(turn2ProjectMemorySection).toContain("PROJ_B_UNIQUE_MEMORY_TITLE");
	});
});
