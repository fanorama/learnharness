import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { DispatchCard } from "../components/artifacts/dispatch-card.tsx";
import { JobsContext } from "../components/jobs-context.ts";
import type { JobKind, JobRecord } from "../src/core/contracts.ts";

/**
 * Retry on a failed demo's dispatch card (upstream issue #425): visibility
 * rules, the newest-attempt rule, and the request's in-flight / error states.
 * Real React handlers on an isolated DOM; fetch is wholly stubbed.
 */
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const originalFetch = globalThis.fetch;
const MODELS_REFUSAL = "No model configured — set up your models first (missing: cheap)";
const KEY_REFUSAL = "No OpenRouter key is set — add one in Settings → Keys";

let seq = 0;
const job = (over: Partial<JobRecord> = {}): JobRecord => {
	seq++;
	return {
		id: `job_${seq}`,
		kind: "demo",
		chatId: "c1",
		toolCallId: "t1",
		status: "error",
		error: "FAILED: headless crashed",
		activity: "failed",
		createdAt: new Date(Date.UTC(2026, 10, 1, 12, 0, seq)).toISOString(),
		updatedAt: new Date(Date.UTC(2026, 10, 1, 12, 0, seq)).toISOString(),
		...over,
	};
};

const card = (jobs: JobRecord[], kind: JobKind = "demo") => (
	<JobsContext.Provider value={jobs}>
		<DispatchCard toolCallId="t1" kind={kind} />
	</JobsContext.Provider>
);

describe("DispatchCard — where Retry appears", () => {
	it("a failed demo shows Retry next to the red 'failed'", () => {
		const html = renderToStaticMarkup(card([job()]));
		assert.ok(html.includes("failed"));
		assert.ok(html.includes("text-red-500"));
		assert.ok(html.includes('data-testid="dispatch-retry"'));
		assert.match(html, />Retry</);
		assert.ok(!html.includes("dispatch-retry-error"));
	});

	it("never on refused/setup cards", () => {
		for (const error of [MODELS_REFUSAL, KEY_REFUSAL]) {
			const html = renderToStaticMarkup(card([job({ error })]));
			assert.ok(html.includes('data-testid="dispatch-refused"'));
			assert.ok(!html.includes("dispatch-retry"), error);
		}
	});

	it("never on failed research, visual or pdf cards", () => {
		for (const kind of ["research", "visual", "pdf"] as const) {
			const html = renderToStaticMarkup(card([job({ kind })], kind));
			assert.ok(html.includes("failed"), kind);
			assert.ok(!html.includes("dispatch-retry"), kind);
		}
	});

	it("never on a running or finished demo", () => {
		assert.ok(!renderToStaticMarkup(card([job({ status: "running", error: undefined })])).includes("dispatch-retry"));
		const done = renderToStaticMarkup(card([job({ status: "done", error: undefined })]));
		assert.ok(done.includes("finished"));
		assert.ok(!done.includes("dispatch-retry"));
	});
});

describe("DispatchCard — it follows the newest attempt", () => {
	it("a running retry replaces the failed card", () => {
		const failed = job();
		const retry = job({ retryOf: failed.id, status: "running", error: undefined, activity: "building demo" });
		// The jobs feed lists newest activity first — order must not matter.
		for (const jobs of [[retry, failed], [failed, retry]]) {
			const html = renderToStaticMarkup(card(jobs));
			assert.ok(html.includes('data-testid="dispatch-card"'));
			assert.ok(html.includes("building demo"));
			assert.ok(!html.includes("dispatch-retry"));
			assert.ok(!html.includes("failed"));
		}
	});

	it("a finished retry reads finished", () => {
		const failed = job();
		const retry = job({ retryOf: failed.id, status: "done", error: undefined });
		const html = renderToStaticMarkup(card([failed, retry]));
		assert.ok(html.includes("finished"));
		assert.ok(!html.includes("dispatch-retry"));
	});

	it("a superseded attempt is ignored even when it looks newer", () => {
		const failed = job({ createdAt: "2026-11-01T13:00:00.000Z" });
		const retry = job({ retryOf: failed.id, status: "done", error: undefined, createdAt: "2026-11-01T12:00:00.000Z" });
		const html = renderToStaticMarkup(card([failed, retry]));
		assert.ok(html.includes("finished"));
	});

	it("among unsuperseded attempts the newest createdAt wins; other tool parts are ignored", () => {
		const older = job({ status: "done", error: undefined });
		const newer = job();
		const foreign = job({ toolCallId: "t2", status: "done", error: undefined });
		const html = renderToStaticMarkup(card([older, foreign, newer]));
		assert.ok(html.includes("failed"));
		assert.ok(html.includes("dispatch-retry"));
	});

	it("Retry again appears when the new attempt fails, and targets that attempt", async () => {
		const failed = job();
		const retry = job({ retryOf: failed.id });
		const calls = stubFetch(() => Response.json({ job: {} }, { status: 201 }));
		await mount(card([failed, retry]));
		await click(button());
		assert.equal(calls.length, 1);
		assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { chatId: "c1", jobId: retry.id });
	});
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
	if (root) await act(async () => root!.unmount());
	root = null;
	host?.remove();
	host = null;
	globalThis.fetch = originalFetch;
});

interface Call {
	url: string;
	init?: RequestInit;
}

function stubFetch(respond: (call: Call) => Response | Promise<Response>): Call[] {
	const calls: Call[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const call = { url: String(input), init };
		calls.push(call);
		return respond(call);
	}) as typeof fetch;
	return calls;
}

async function mount(tree: React.ReactElement) {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(tree);
	});
}

function button(): HTMLButtonElement {
	const node = document.querySelector<HTMLButtonElement>('[data-testid="dispatch-retry"]');
	assert.ok(node, "expected the Retry button");
	return node;
}

async function click(target: HTMLElement) {
	await act(async () => {
		target.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
	});
}

describe("Retry — the request", () => {
	it("posts {chatId, jobId} to /api/jobs and shows 'Retrying…' (disabled) while in flight", async () => {
		const failed = job();
		let release!: (res: Response) => void;
		const calls = stubFetch(() => new Promise<Response>((resolve) => (release = resolve)));
		await mount(card([failed]));

		await click(button());
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.url, "/api/jobs");
		assert.equal(calls[0]!.init?.method, "POST");
		assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { chatId: "c1", jobId: failed.id });
		assert.equal(button().textContent, "Retrying…");
		assert.equal(button().disabled, true);

		await act(async () => release(Response.json({ job: {} }, { status: 201 })));
		// The request succeeded: stay "Retrying…" until the feed brings the new attempt.
		assert.equal(button().textContent, "Retrying…");
		assert.equal(button().disabled, true);
		assert.ok(!document.querySelector('[data-testid="dispatch-retry-error"]'));
	});

	it("a double click sends ONE request (guarded by a ref, before React re-renders)", async () => {
		const calls = stubFetch(() => new Promise<Response>(() => {}));
		await mount(card([job()]));
		const target = button();
		await act(async () => {
			target.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
			target.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
		});
		assert.equal(calls.length, 1);
	});

	it("a failed request shows the red inline error and the button stays clickable", async () => {
		let attempt = 0;
		const calls = stubFetch(() => (attempt++ === 0 ? Response.json({ error: "x" }, { status: 503 }) : Response.json({ job: {} }, { status: 201 })));
		await mount(card([job()]));

		await click(button());
		const error = document.querySelector<HTMLElement>('[data-testid="dispatch-retry-error"]');
		assert.ok(error);
		assert.equal(error.textContent, "Could not retry the demo. Try again.");
		assert.match(error.className, /text-red-500/);
		assert.equal(button().textContent, "Retry");
		assert.equal(button().disabled, false);

		await click(button());
		assert.equal(calls.length, 2, "another attempt is allowed");
		assert.equal(button().textContent, "Retrying…");
		assert.ok(!document.querySelector('[data-testid="dispatch-retry-error"]'), "the error clears on the next attempt");
	});

	it("a network error is handled the same way", async () => {
		stubFetch(() => {
			throw new TypeError("fetch failed");
		});
		await mount(card([job()]));
		await click(button());
		assert.equal(document.querySelector('[data-testid="dispatch-retry-error"]')?.textContent, "Could not retry the demo. Try again.");
		assert.equal(button().disabled, false);
	});

	it("when the new attempt arrives the card follows it (no stale 'Retrying…')", async () => {
		const failed = job();
		stubFetch(() => Response.json({ job: {} }, { status: 201 }));
		await mount(card([failed]));
		await click(button());
		assert.equal(button().textContent, "Retrying…");

		const retry = job({ retryOf: failed.id, status: "running", error: undefined, activity: "building demo" });
		await act(async () => {
			root!.render(card([retry, failed]));
		});
		assert.ok(!document.querySelector('[data-testid="dispatch-retry"]'));
		assert.equal(document.querySelector('[data-testid="dispatch-activity-line"]')?.textContent, "building demo");
	});
});
