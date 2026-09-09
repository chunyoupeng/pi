import type { InlineExtension } from "../core/extensions/types.ts";
import btwExtension from "./btw/index.ts";
import goalExtension from "./goal/index.ts";
import llamaExtension from "./llama/index.ts";
import todoExtension from "./todo/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "btw", factory: btwExtension },
	{ name: "goal", factory: goalExtension },
	{ name: "todo", factory: todoExtension },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
];
