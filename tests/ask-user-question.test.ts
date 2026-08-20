import { describe, expect, it } from "vitest";

import askUserQuestion, { QuestionParams } from "../extensions/index.ts";

type Tool = {
	name: string;
	description: string;
	executionMode?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	execute: (id: string, params: any, signal: undefined, update: undefined, ctx: any) => Promise<any>;
};

type Overlay = { handleInput(data: string): void; render(width: number): string[] };

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const tui = { requestRender() {}, terminal: { rows: 24 } };

function setup(): Tool {
	let tool: Tool | undefined;
	askUserQuestion({ registerTool(value: Tool) { tool = value; } } as never);
	if (!tool) throw new Error("AskUserQuestion was not registered");
	return tool;
}

function immediate(result: unknown) {
	return { hasUI: true, mode: "tui", ui: { custom: async () => [result] } };
}

function open(tool: Tool, params: any) {
	let overlay: Overlay | undefined;
	let customCalls = 0;
	const workingVisible: Array<boolean | undefined> = [];
	const result = tool.execute("call", params, undefined, undefined, {
		hasUI: true,
		mode: "tui",
		ui: {
			custom(factory: any) {
				customCalls += 1;
				return new Promise((resolve) => { overlay = factory(tui, theme, {}, resolve); });
			},
			setWorkingVisible(value?: boolean) { workingVisible.push(value); },
		},
	});
	if (!overlay) throw new Error("overlay did not open");
	return { overlay, result, customCalls: () => customCalls, workingVisible };
}

const options = [{ label: "Alpha" }, { label: "Beta" }];
const key = { down: "\x1b[B", enter: "\r", escape: "\x1b", space: " " };

describe("AskUserQuestion", () => {

	it("registers only the tool contract, with bounded Claude-compatible schema", () => {
		const tool = setup();
		expect(tool.name).toBe("AskUserQuestion");
		expect(tool.executionMode).toBe("sequential");
		expect(tool.description).toContain("structured preference");
		expect(tool.promptSnippet).toBeUndefined();
		expect(tool.promptGuidelines).toBeUndefined();
		const schema = QuestionParams as any;
		expect(schema.properties.options).toMatchObject({ minItems: 2, maxItems: 4 });
		expect(schema.properties.questions).toMatchObject({ minItems: 1, maxItems: 4 });
	});

	it("fails safely when the intentionally flat schema receives an incomplete shape", async () => {
		const tool = setup();
		const noQuestion = await tool.execute("call", {}, undefined, undefined, {});
		expect(noQuestion.content[0].text).toBe("Error: No question provided");
		const noOptions = await tool.execute("call", { question: "Pick" }, undefined, undefined, {
			hasUI: true, mode: "tui", ui: { custom: () => { throw new Error("must not open UI"); } },
		});
		expect(noOptions.content[0].text).toBe("Error: No options provided");
	});

	it("returns a non-blocking plain-text fallback in headless modes", async () => {
		const result = await setup().execute("call", { question: "Pick", options }, undefined, undefined, { hasUI: false, mode: "json" });
		expect(result.content[0].text).toContain("Ask the user in plain text instead");
		expect(result.details.answer).toBeNull();
	});

	it("handles single-select and cancel", async () => {
		const tool = setup();
		const picked = await tool.execute("call", { question: "Pick", options }, undefined, undefined, immediate({ answer: "Beta", wasCustom: false, index: 2 }));
		expect(picked.content[0].text).toBe("User selected: 2. Beta");
		const cancelled = await tool.execute("call", { question: "Pick", options }, undefined, undefined, immediate(null));
		expect(cancelled.details.answer).toBeNull();
	});

	it("accepts Other free text", async () => {
		const { overlay, result } = open(setup(), { question: "Pick", options });
		overlay.handleInput(key.down);
		overlay.handleInput(key.down);
		overlay.handleInput(key.enter);
		overlay.handleInput("custom answer");
		overlay.handleInput(key.enter);
		expect((await result).content[0].text).toBe("User wrote: custom answer");
	});

	it("supports multi-select", async () => {
		const { overlay, result } = open(setup(), { question: "Pick several", options, multiSelect: true });
		overlay.handleInput(key.space);
		overlay.handleInput(key.down);
		overlay.handleInput(key.space);
		overlay.handleInput(key.enter);
		expect((await result).details.answer).toBe("Alpha, Beta");
	});

	it("keeps one TUI mounted while advancing through a batch", async () => {
		const { overlay, result, customCalls, workingVisible } = open(setup(), { questions: [
			{ question: "First?", header: "Direction", options },
			{ question: "Second?", header: "Preference", options },
		] });
		expect(customCalls()).toBe(1);
		expect(overlay.render(80).join("\n")).toContain("Question 1/2");
		overlay.handleInput(key.enter);
		expect(customCalls()).toBe(1);
		expect(overlay.render(80).join("\n")).toContain("Question 2/2");
		overlay.handleInput(key.down);
		overlay.handleInput(key.enter);
		const completed = await result;
		expect(completed.details.questions.map((item: any) => item.answer)).toEqual(["Alpha", "Beta"]);
		expect(workingVisible).toEqual([false, true]);
	});

	it("uses native dialogs in RPC mode, including Other input", async () => {
		const calls: string[] = [];
		const result = await setup().execute("call", { question: "Pick", header: "Preference", options }, undefined, undefined, {
			hasUI: true,
			mode: "rpc",
			ui: {
				select: async (title: string) => { calls.push(title); return "3. Type something."; },
				input: async () => "RPC answer",
			},
		});
		expect(calls[0]).toContain("[Preference]");
		expect(result.details).toMatchObject({ answer: "RPC answer", wasCustom: true });
	});

	it("supports multi-select over repeated native RPC dialogs", async () => {
		const choices = ["1. [ ] Alpha", "2. [ ] Beta", "3. Done"];
		let call = 0;
		const result = await setup().execute("call", { question: "Pick several", options, multiSelect: true }, undefined, undefined, {
			hasUI: true,
			mode: "rpc",
			ui: { select: async (_title: string, shown: string[]) => {
				const wanted = call++ === 0 ? choices[0] : call === 2 ? "2. [ ] Beta" : "3. Done";
				return shown.find((item) => item === wanted);
			} },
		});
		expect(result.details.answer).toBe("Alpha, Beta");
		expect(call).toBe(3);
	});
});
