import type { InlineExtension } from "../core/extensions/types.ts";
import goalExtension from "./goal/index.ts";
import llamaExtension from "./llama/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "goal", factory: goalExtension },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
];
