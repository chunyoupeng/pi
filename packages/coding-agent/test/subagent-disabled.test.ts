import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BUILTIN_SUBAGENT_PROFILES,
	loadCustomProfilesFromDir,
	resolveSubagentProfiles,
} from "../src/core/subagent/profiles.ts";
import { runSubagent } from "../src/core/subagent/runner.ts";
import { SubagentSessionPool } from "../src/core/subagent/session-pool.ts";
import type { SubagentProfile } from "../src/core/subagent/types.ts";
import { createSubagentTool, createSubagentToolDefinition } from "../src/core/tools/subagent.ts";

function writeProfile(dir: string, filename: string, frontmatter: string, body = ""): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, filename), `---\n${frontmatter}\n---\n${body}`);
}

const sdkProfile: SubagentProfile = {
	name: "worker",
	description: "SDK implementation agent",
	systemPrompt: "Complete the assigned task.",
	tools: [],
};

describe("Disabled subagent profiles", () => {
	let testDir: string;
	let cwd: string;
	let agentDir: string;
	let userAgentsDir: string;
	let projectAgentsDir: string;
	let faux: ReturnType<typeof registerFauxProvider>;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "subagent-disabled-"));
		cwd = join(testDir, "project");
		agentDir = join(testDir, "agent");
		userAgentsDir = join(agentDir, "agents");
		projectAgentsDir = join(cwd, ".pi", "agents");
		mkdirSync(userAgentsDir, { recursive: true });
		mkdirSync(projectAgentsDir, { recursive: true });
		faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
	});

	afterEach(() => {
		faux.unregister();
		rmSync(testDir, { recursive: true, force: true });
	});

	it.each([
		{ label: "boolean true", field: "disabled: true", disabled: true },
		{ label: "boolean false", field: "disabled: false", disabled: false },
		{ label: "quoted true", field: 'disabled: "true"', disabled: false },
		{ label: "quoted false", field: 'disabled: "false"', disabled: false },
		{ label: "number", field: "disabled: 1", disabled: false },
		{ label: "null", field: "disabled: null", disabled: false },
		{ label: "absent field", field: "", disabled: false },
	])("parses disabled frontmatter strictly ($label)", ({ field, disabled }) => {
		writeProfile(userAgentsDir, "worker.md", `name: worker\n${field}`, "Custom worker prompt.");

		const loaded = loadCustomProfilesFromDir(userAgentsDir, "user");
		expect(loaded).toHaveLength(1);
		if (disabled) expect(loaded[0].disabled).toBe(true);
		else expect([false, undefined]).toContain(loaded[0].disabled);
		expect(loaded[0].systemPrompt).toBe("Custom worker prompt.");
		const resolved = resolveSubagentProfiles(cwd, agentDir);
		expect(Object.hasOwn(resolved, "worker")).toBe(!disabled);
		if (!disabled) expect(resolved.worker.source).toBe("user");
	});

	it("uses the filename for a bodyless tombstone without a name", () => {
		writeProfile(projectAgentsDir, "reviewer.md", "disabled: true");

		expect(loadCustomProfilesFromDir(projectAgentsDir, "project")).toEqual([
			expect.objectContaining({ name: "reviewer", disabled: true, source: "project" }),
		]);
		expect(resolveSubagentProfiles(cwd, agentDir).reviewer).toBeUndefined();
	});

	it("does not treat non-Markdown files or Markdown body text as disabled frontmatter", () => {
		writeFileSync(join(userAgentsDir, "worker.json"), '{"name":"worker","disabled":true}');
		writeFileSync(join(userAgentsDir, "reviewer.yaml"), "name: reviewer\ndisabled: true\n");
		writeFileSync(join(projectAgentsDir, "scout.md"), "disabled: true\nThis is prompt text.");

		expect(loadCustomProfilesFromDir(userAgentsDir, "user")).toEqual([]);
		const resolved = resolveSubagentProfiles(cwd, agentDir);
		expect(Object.keys(resolved).sort()).toEqual(Object.keys(BUILTIN_SUBAGENT_PROFILES).sort());
		expect(resolved.scout.systemPrompt).toContain("disabled: true");
	});

	it("lets a name-only user tombstone disable a built-in without falling back to it", () => {
		writeProfile(userAgentsDir, "disable-worker.md", "name: worker\ndisabled: true");

		expect(loadCustomProfilesFromDir(userAgentsDir, "user")).toEqual([
			expect.objectContaining({ name: "worker", disabled: true }),
		]);
		const resolved = resolveSubagentProfiles(cwd, agentDir);
		expect(resolved.worker).toBeUndefined();
		expect(resolved["disable-worker"]).toBeUndefined();
		expect(resolved.scout).toEqual(BUILTIN_SUBAGENT_PROFILES.scout);
		expect(BUILTIN_SUBAGENT_PROFILES.worker.disabled).not.toBe(true);
	});

	it("lets project tombstones disable both user overrides and user-only roles", () => {
		for (const name of ["worker", "tester"]) {
			writeProfile(userAgentsDir, `${name}.md`, `name: ${name}`, "User prompt.");
			writeProfile(projectAgentsDir, `${name}.md`, `name: ${name}\ndisabled: true`);
		}

		const resolved = resolveSubagentProfiles(cwd, agentDir);
		expect(resolved.worker).toBeUndefined();
		expect(resolved.tester).toBeUndefined();
		expect(resolved.planner).toEqual(BUILTIN_SUBAGENT_PROFILES.planner);
	});

	it("lets an ordinary project profile re-enable a user-disabled role", () => {
		writeProfile(userAgentsDir, "worker.md", "name: worker\ndisabled: true");
		writeProfile(projectAgentsDir, "worker.md", "name: worker\ntools: read", "Project worker prompt.");

		expect(resolveSubagentProfiles(cwd, agentDir).worker).toMatchObject({
			name: "worker",
			source: "project",
			tools: ["read"],
			systemPrompt: "Project worker prompt.",
		});
	});

	it("merges SDK profiles last before filtering, allowing both disabling and re-enabling", () => {
		writeProfile(userAgentsDir, "worker.md", "name: worker", "User prompt.");
		writeProfile(projectAgentsDir, "worker.md", "name: worker\ndisabled: true");
		writeProfile(projectAgentsDir, "reviewer.md", "name: reviewer", "Project review prompt.");
		const customProfiles: Record<string, SubagentProfile> = {
			worker: { ...sdkProfile, disabled: false },
			reviewer: { ...sdkProfile, name: "reviewer", disabled: true },
			tester: { ...sdkProfile, name: "tester", disabled: true },
		};

		const resolved = resolveSubagentProfiles(cwd, agentDir, customProfiles);
		expect(resolved.worker).toEqual(customProfiles.worker);
		expect(resolved.reviewer).toBeUndefined();
		expect(resolved.tester).toBeUndefined();
		expect(resolved.scout).toEqual(BUILTIN_SUBAGENT_PROFILES.scout);
		expect(customProfiles.reviewer.disabled).toBe(true);
	});

	it("keeps an empty profile set when all built-ins are disabled and reports available: none", async () => {
		for (const name of Object.keys(BUILTIN_SUBAGENT_PROFILES)) {
			writeProfile(projectAgentsDir, `${name}.md`, `name: ${name}\ndisabled: true`);
		}

		expect(resolveSubagentProfiles(cwd, agentDir)).toEqual({});
		const definition = createSubagentToolDefinition(cwd, { agentDir });
		expect(definition.description).toMatch(/\bnone\b/i);
		for (const name of Object.keys(BUILTIN_SUBAGENT_PROFILES)) {
			expect(definition.description).not.toMatch(new RegExp(`\\b${name}\\b`));
		}
		const tool = createSubagentTool(cwd, { agentDir, defaultModel: faux.getModel() });
		await expect(tool.execute("empty", { agent: "worker", task: "Do not run." })).rejects.toThrow(
			/Available subagents:\s*none\b/i,
		);
		expect(faux.state.callCount).toBe(0);
	});

	it("advertises only enabled roles and avoids hard-coded roles in schema and prompt examples", () => {
		writeProfile(userAgentsDir, "worker.md", "name: worker\ndisabled: true");
		writeProfile(projectAgentsDir, "reviewer.md", "name: reviewer\ndisabled: true");
		const definition = createSubagentToolDefinition(cwd, {
			agentDir,
			customProfiles: {
				planner: { ...sdkProfile, name: "planner", disabled: true },
				tester: { ...sdkProfile, name: "tester", description: "Writes tests" },
			},
		});

		expect(definition.description).toMatch(/\bscout\b/);
		expect(definition.description).toMatch(/\btester\b/);
		for (const name of ["worker", "reviewer", "planner"]) {
			expect(definition.description).not.toMatch(new RegExp(`\\b${name}\\b`));
		}
		const examples = JSON.stringify({
			parameters: definition.parameters,
			snippet: definition.promptSnippet,
			guidelines: definition.promptGuidelines,
		});
		expect(examples).not.toMatch(/\b(worker|reviewer)\b/);
	});

	it("reloads configuration for new calls and resumes, without disrupting other roles", async () => {
		faux.setResponses([
			fauxAssistantMessage("Initial worker output"),
			fauxAssistantMessage("Worker follow-up"),
			fauxAssistantMessage("Scout still works"),
			fauxAssistantMessage("Worker re-enabled"),
		]);
		const pool = new SubagentSessionPool();
		const tool = createSubagentTool(cwd, { agentDir, defaultModel: faux.getModel(), sessionPool: pool });
		const first = await tool.execute("first", { agent: "worker", task: "Start work." });
		expect(first.details?.status).toBe("completed");
		const sessionId = first.details!.sessionId!;
		expect(sessionId).toBeDefined();
		const resumed = await tool.execute("resume", { agent: "worker", task: "Continue.", sessionId });
		expect(resumed.details?.isResumed).toBe(true);
		const session = pool.get(sessionId)!;
		const messages = [...session.subAgent.state.messages];

		writeProfile(userAgentsDir, "worker.md", "name: worker\ndisabled: true");
		for (const params of [{}, { sessionId }, { sessionId, resetSession: true }]) {
			await expect(tool.execute("disabled", { agent: "worker", task: "Must not run.", ...params })).rejects.toThrow(
				/worker/i,
			);
		}
		expect(faux.state.callCount).toBe(2);
		expect(pool.get(sessionId)).toBe(session);
		expect(session.subAgent.state.messages).toEqual(messages);

		const scout = await tool.execute("scout", { agent: "scout", task: "Explore." });
		expect(scout.details).toMatchObject({ status: "completed", finalText: "Scout still works" });

		writeProfile(projectAgentsDir, "worker.md", "name: worker", "Project worker prompt.");
		const enabled = await tool.execute("enabled", { agent: "worker", task: "Continue again.", sessionId });
		expect(enabled.details).toMatchObject({
			status: "completed",
			isResumed: true,
			sessionId,
			finalText: "Worker re-enabled",
		});
		expect(faux.state.callCount).toBe(4);
	});

	it("applies SDK disabled profiles to execution while SDK enabled profiles override project tombstones", async () => {
		writeProfile(projectAgentsDir, "worker.md", "name: worker", "Project worker prompt.");
		writeProfile(projectAgentsDir, "tester.md", "name: tester\ndisabled: true");
		faux.setResponses([fauxAssistantMessage("SDK tester works")]);
		const tool = createSubagentTool(cwd, {
			agentDir,
			defaultModel: faux.getModel(),
			customProfiles: {
				worker: { ...sdkProfile, disabled: true },
				tester: { ...sdkProfile, name: "tester" },
			},
		});

		await expect(tool.execute("disabled-sdk", { agent: "worker", task: "Must not run." })).rejects.toThrow(/worker/i);
		expect(faux.state.callCount).toBe(0);
		const result = await tool.execute("enabled-sdk", { agent: "tester", task: "Write tests." });
		expect(result.details).toMatchObject({ status: "completed", finalText: "SDK tester works" });
		expect(faux.state.callCount).toBe(1);
	});

	it("rejects direct execution of a disabled profile before model resolution", async () => {
		await expect(
			runSubagent({ profile: { ...sdkProfile, disabled: true }, task: "Must not run.", cwd }),
		).rejects.toThrow(/disabled/i);
		expect(faux.state.callCount).toBe(0);
	});

	it("rejects direct disabled-profile resumes and resets without modifying the existing session", async () => {
		faux.setResponses([fauxAssistantMessage("Initial direct output")]);
		const pool = new SubagentSessionPool();
		const options = { profile: sdkProfile, task: "Start.", cwd, parentModel: faux.getModel(), sessionPool: pool };
		const first = await runSubagent(options);
		expect(first.details.status).toBe("completed");
		const sessionId = first.details.sessionId!;
		const session = pool.get(sessionId)!;
		const messages = [...session.subAgent.state.messages];

		for (const resetSession of [false, true]) {
			await expect(
				runSubagent({
					...options,
					profile: { ...sdkProfile, disabled: true },
					sessionId,
					resetSession,
				}),
			).rejects.toThrow(/disabled/i);
			expect(pool.get(sessionId)).toBe(session);
			expect(session.subAgent.state.messages).toEqual(messages);
		}
		expect(faux.state.callCount).toBe(1);
	});
});
