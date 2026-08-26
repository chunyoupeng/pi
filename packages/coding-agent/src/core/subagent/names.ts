export const SUBAGENT_NAMES = [
	"Jack",
	"Alice",
	"Bob",
	"Charlie",
	"David",
	"Emma",
	"Frank",
	"Grace",
	"Henry",
	"Ivy",
	"Leo",
	"Maya",
	"Noah",
	"Olivia",
	"Peter",
	"Rose",
	"Sam",
	"Tina",
	"Victor",
	"Wendy",
	"Alex",
	"Bruce",
	"Chloe",
	"Daniel",
	"Elena",
	"Felix",
	"Hannah",
	"Iris",
	"Lucas",
	"Mia",
	"Oscar",
	"Ruby",
	"Sophia",
	"Theo",
	"Zoe",
] as const;

export function generateRandomName(): string {
	const index = Math.floor(Math.random() * SUBAGENT_NAMES.length);
	return SUBAGENT_NAMES[index] ?? "Worker";
}

export function generateSubagentSessionId(role: string, name: string): string {
	const sanitizedRole = role.toLowerCase().replace(/[^a-z0-9_-]/g, "");
	const sanitizedName = name.toLowerCase().replace(/[^a-z0-9_-]/g, "");
	const suffix = Math.random().toString(36).slice(2, 6);
	return `${sanitizedRole || "subagent"}-${sanitizedName || "agent"}-${suffix}`;
}
