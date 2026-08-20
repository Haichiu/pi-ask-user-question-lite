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
const key = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", enter: "\r", escape: "\x1b", space: " " };

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

	it("makes Other discoverable and keeps empty submissions in the editor", async () => {
		const { overlay, result } = open(setup(), { question: "Pick", options });
		overlay.handleInput(key.down);
		overlay.handleInput(key.down);
		const optionsView = overlay.render(80).join("\n");
		expect(optionsView).toContain("Other…");
		expect(optionsView).toContain("Press Enter to type your own answer");
		overlay.handleInput(key.enter);
		overlay.handleInput(key.enter);
		expect(overlay.render(80).join("\n")).toContain("Your answer:");
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

	it("returns to previous TUI questions, replaces answers, and keeps one mount", async () => {
		const { overlay, result, customCalls, workingVisible } = open(setup(), { questions: [
			{ question: "First?", header: "Direction", options },
			{ question: "Second?", header: "Preference", options },
		] });
		overlay.handleInput(key.down);
		overlay.handleInput(key.enter);
		expect(overlay.render(80).join("\n")).toContain("← previous");
		overlay.handleInput(key.left);
		expect(overlay.render(80).join("\n")).toContain("Question 1/2");
		overlay.handleInput(key.up);
		overlay.handleInput(key.enter);
		expect(overlay.render(80).join("\n")).toContain("Question 2/2");
		overlay.handleInput(key.enter);
		const completed = await result;
		expect(completed.details.questions.map((item: any) => item.answer)).toEqual(["Alpha", "Alpha"]);
		expect(customCalls()).toBe(1);
		expect(workingVisible).toEqual([false, true]);
	});

	it("prefills a previous TUI Other answer for editing", async () => {
		const { overlay, result } = open(setup(), { questions: [
			{ question: "First?", options },
			{ question: "Second?", options },
		] });
		overlay.handleInput(key.down);
		overlay.handleInput(key.down);
		overlay.handleInput(key.enter);
		overlay.handleInput("draft");
		overlay.handleInput(key.enter);
		overlay.handleInput(key.left);
		overlay.handleInput(key.enter);
		expect(overlay.render(80).join("\n")).toContain("draft");
		overlay.handleInput(" updated");
		overlay.handleInput(key.enter);
		overlay.handleInput(key.enter);
		expect((await result).details.questions.map((item: any) => item.answer)).toEqual(["draft updated", "Alpha"]);
	});

	it("uses native dialogs in RPC mode, including Other input", async () => {
		const calls: string[] = [];
		const result = await setup().execute("call", { question: "Pick", header: "Preference", options }, undefined, undefined, {
			hasUI: true,
			mode: "rpc",
			ui: {
				select: async (title: string) => { calls.push(title); return "3. Other… — press Enter to type"; },
				input: async () => "RPC answer",
			},
		});
		expect(calls[0]).toContain("[Preference]");
		expect(result.details).toMatchObject({ answer: "RPC answer", wasCustom: true });
	});

	it("returns to previous RPC questions and replaces the earlier answer", async () => {
		const choices = ["2. Beta", "← Previous question", "1. Alpha", "2. Beta"];
		let call = 0;
		const result = await setup().execute("call", { questions: [
			{ question: "First?", options },
			{ question: "Second?", options },
		] }, undefined, undefined, {
			hasUI: true,
			mode: "rpc",
			ui: { select: async (_title: string, shown: string[]) => {
				const wanted = choices[call++];
				return shown.find((item) => item === wanted);
			} },
		});
		expect(result.details.questions.map((item: any) => item.answer)).toEqual(["Alpha", "Beta"]);
		expect(call).toBe(4);
	});

	it("preserves RPC Other drafts and treats blank as unchanged", async () => {
		const selections = ["3. Other… — press Enter to type", "← Previous question", "3. Other… — press Enter to type", "1. Alpha"];
		const typed = ["draft", ""];
		const placeholders: string[] = [];
		let selectCall = 0;
		let inputCall = 0;
		const result = await setup().execute("call", { questions: [
			{ question: "First?", options },
			{ question: "Second?", options },
		] }, undefined, undefined, {
			hasUI: true,
			mode: "rpc",
			ui: {
				select: async (_title: string, shown: string[]) => {
					const wanted = selections[selectCall++];
					return shown.find((item) => item === wanted);
				},
				input: async (_title: string, placeholder: string) => { placeholders.push(placeholder); return typed[inputCall++]; },
			},
		});
		expect(result.details.questions.map((item: any) => item.answer)).toEqual(["draft", "Alpha"]);
		expect(placeholders.at(-1)).toContain("Current answer: draft");
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
