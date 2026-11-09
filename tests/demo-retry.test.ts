/**
 * Retry a failed demo (upstream issue #425) — the server side, deterministic
 * and offline:
 *
 *   1. validation: 400 (ids), 404 (chat/job), 409 (kind, status, setup
 *      refusals, unavailable request), 503 (respawn missing / throws)
 *   2. a retry is a NEW job: same toolCallId, `retryOf`, saved input; the
 *      failed attempt and the chat record stay untouched
 *   3. idempotency: repeated requests never create a second successor
 *   4. legacy jobs: the request comes back from the transcript
 *   5. one tool part, several jobs: the dispatch dedup (findJobByToolCallId)
 *      never double-spawns, and the new attempt's result still reaches the
 *      chat through the same delivery paths
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { PATHS } from "../config.ts";
import { type JobRecord, type SteerMessage, steerDelivered } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { SteerInput } from "../src/core/input-events.ts";
import { jobTools } from "../src/agent/tools/jobs.ts";
import { createJobRunner } from "../src/agent/subagents/runner.ts";
import {
	deliverJobResult,
	discardChatDeliveries,
	retryDemoJob,
	setJobRespawn,
	setTurnRunner,
	type JobRespawn,
} from "../src/server/jobs.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import { POST } from "../app/api/jobs/route.ts";

const JOBS_DIR = path.join(PATHS.data, "jobs");
const createdChats: string[] = [];
const createdJobs: string[] = [];

const DEMO_INPUT = { title: "Compounding", brief: "Sweep the rate and the horizon; show the curve." };
const MODELS_REFUSAL = "No model configured — set up your models first (missing: cheap)";
const KEY_REFUSAL = "No OpenRouter key is set — add one in Settings → Keys";

afterEach(() => {
	for (const chatId of createdChats) discardChatDeliveries(chatId);
	setJobRespawn(() => {});
	setTurnRunner(async () => 200);
});

after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
	for (const id of createdJobs) {
		try {
			fs.unlinkSync(path.join(JOBS_DIR, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
});

function newChat(messages: LhMessage[] = [{ id: "u1", role: "user", content: "teach me compounding", timestamp: 1 } as never]) {
	const chat = chatStore.createChat("Test: demo retry");
	createdChats.push(chat.id);
	chatStore.saveMessages(chat.id, messages);
	return chat;
}

/** A job that has already failed (the state Retry is offered in). */
function failedJob(chatId: string, over: Partial<JobRecord> & { toolCallId?: string; kind?: JobRecord["kind"] } = {}): JobRecord {
	const { toolCallId = "call-d1", kind = "demo", ...patch } = over;
	const job = jobStore.createJob({ kind, chatId, toolCallId, input: DEMO_INPUT });
	createdJobs.push(job.id);
	return jobStore.updateJob(job.id, {
		status: "error",
		activity: "failed",
		error: "FAILED: headless crashed",
		result: { title: "Compounding", html: "", tested: true, notes: "FAILED: headless crashed" },
		delivery: { kind: "result", status: "delivered" },
		usage: { model: "x:y", inputTokens: 10, outputTokens: 5, cacheReadTokens: undefined, cacheWriteTokens: undefined, reasoningTokens: undefined, steps: 1 } as never,
		...patch,
	})!;
}

/** Wire a counting respawn; returns the spawned job ids. */
function wireRespawn(): string[] {
	const spawned: string[] = [];
	setJobRespawn((jobId) => {
		spawned.push(jobId);
	});
	return spawned;
}

function track(job: JobRecord): JobRecord {
	createdJobs.push(job.id);
	return job;
}

function assertFailure(outcome: ReturnType<typeof retryDemoJob>, status: number) {
	assert.equal(outcome.ok, false);
	if (!outcome.ok) assert.equal(outcome.status, status, outcome.error);
}

async function postJobs(body: unknown): Promise<Response> {
	return POST(
		new Request("http://test/api/jobs", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	);
}

describe("retryDemoJob — validation happens before any work starts", () => {
	it("400 for malformed ids", () => {
		const spawned = wireRespawn();
		const chat = newChat();
		const job = failedJob(chat.id);
		assertFailure(retryDemoJob(undefined, job.id), 400);
		assertFailure(retryDemoJob("../etc", job.id), 400);
		assertFailure(retryDemoJob(chat.id, undefined), 400);
		assertFailure(retryDemoJob(chat.id, 42), 400);
		assertFailure(retryDemoJob(chat.id, "job id with spaces"), 400);
		assert.deepEqual(spawned, []);
	});

	it("404 for an unknown chat, an unknown job, and a job of another chat", () => {
		const spawned = wireRespawn();
		const chat = newChat();
		const other = newChat();
		const job = failedJob(chat.id);
		assertFailure(retryDemoJob("chat_does_not_exist", job.id), 404);
		assertFailure(retryDemoJob(chat.id, "job_does_not_exist"), 404);
		assertFailure(retryDemoJob(other.id, job.id), 404);
		assert.deepEqual(spawned, []);
		assert.equal(jobStore.listJobs(chat.id).length, 1);
	});

	it("409 unless the job is a FAILED DEMO", () => {
		const spawned = wireRespawn();
		const chat = newChat();
		for (const kind of ["research", "visual", "pdf"] as const) {
			assertFailure(retryDemoJob(chat.id, failedJob(chat.id, { kind, toolCallId: `call-${kind}` }).id), 409);
		}
		const running = failedJob(chat.id, { toolCallId: "call-running", status: "running", error: undefined });
		assertFailure(retryDemoJob(chat.id, running.id), 409);
		const done = failedJob(chat.id, { toolCallId: "call-done", status: "done", error: undefined });
		assertFailure(retryDemoJob(chat.id, done.id), 409);
		assert.deepEqual(spawned, []);
	});

	it("409 for a model-setup or provider-key refusal — that needs setup, not a retry", () => {
		const spawned = wireRespawn();
		const chat = newChat();
		assertFailure(retryDemoJob(chat.id, failedJob(chat.id, { toolCallId: "call-m", error: MODELS_REFUSAL }).id), 409);
		assertFailure(retryDemoJob(chat.id, failedJob(chat.id, { toolCallId: "call-k", error: KEY_REFUSAL }).id), 409);
		assert.deepEqual(spawned, []);
	});

	it("409 when the original request is unavailable or incomplete", () => {
		const spawned = wireRespawn();
		const chat = newChat(); // transcript carries no demo call
		const noInput = jobStore.createJob({ kind: "demo", chatId: chat.id, toolCallId: "call-gone" });
		createdJobs.push(noInput.id);
		jobStore.updateJob(noInput.id, { status: "error", error: "FAILED: x" });
		assertFailure(retryDemoJob(chat.id, noInput.id), 409);

		const blankTitle = failedJob(chat.id, { toolCallId: "call-blank", input: { title: "  ", brief: "b" } });
		assertFailure(retryDemoJob(chat.id, blankTitle.id), 409);
		const noBrief = failedJob(chat.id, { toolCallId: "call-nobrief", input: { title: "T" } });
		assertFailure(retryDemoJob(chat.id, noBrief.id), 409);
		const junk = failedJob(chat.id, { toolCallId: "call-junk", input: "not an object" });
		assertFailure(retryDemoJob(chat.id, junk.id), 409);

		assert.deepEqual(spawned, []);
		assert.equal(jobStore.listJobs(chat.id).length, 4, "no job was created");
	});
});

describe("retryDemoJob — a retry is a new attempt beside the failed one", () => {
	it("creates a running job with the same toolCallId, retryOf and input, and spawns it", () => {
		const spawned = wireRespawn();
		const chat = newChat();
		const failed = failedJob(chat.id);
		const before = structuredClone(jobStore.getJob(failed.id));
		const messagesBefore = structuredClone(chatStore.getChat(chat.id)!.messages);

		const outcome = retryDemoJob(chat.id, failed.id);
		assert.ok(outcome.ok);
		if (!outcome.ok) return;
		track(outcome.job);
		assert.equal(outcome.created, true);
		assert.notEqual(outcome.job.id, failed.id);
		assert.equal(outcome.job.kind, "demo");
		assert.equal(outcome.job.chatId, chat.id);
		assert.equal(outcome.job.toolCallId, failed.toolCallId);
		assert.equal(outcome.job.retryOf, failed.id);
		assert.equal(outcome.job.status, "running");
		assert.deepEqual(outcome.job.input, DEMO_INPUT);
		assert.deepEqual(jobStore.getJob(outcome.job.id), outcome.job, "persisted, retryOf included");
		assert.deepEqual(spawned, [outcome.job.id], "started through the existing respawn");

		assert.deepEqual(jobStore.getJob(failed.id), before, "the failed attempt is untouched (status, usage, delivery)");
		assert.deepEqual(chatStore.getChat(chat.id)!.messages, messagesBefore, "no learner message was added");
	});

	it("is idempotent: repeating the request returns the same successor and never spawns twice", () => {
		const spawned = wireRespawn();
		const chat = newChat();
		const failed = failedJob(chat.id);

		const first = retryDemoJob(chat.id, failed.id);
		const second = retryDemoJob(chat.id, failed.id);
		const third = retryDemoJob(chat.id, failed.id);
		assert.ok(first.ok && second.ok && third.ok);
		if (!first.ok || !second.ok || !third.ok) return;
		track(first.job);
		assert.equal(first.created, true);
		assert.equal(second.created, false);
		assert.equal(second.job.id, first.job.id);
		assert.equal(third.job.id, first.job.id);
		assert.deepEqual(spawned, [first.job.id]);
		assert.equal(jobStore.listJobs(chat.id).filter((j) => j.retryOf === failed.id).length, 1);
	});

	it("a failed retry can itself be retried (chain of attempts)", () => {
		wireRespawn();
		const chat = newChat();
		const failed = failedJob(chat.id);
		const first = retryDemoJob(chat.id, failed.id);
		assert.ok(first.ok);
		if (!first.ok) return;
		track(first.job);
		jobStore.updateJob(first.job.id, { status: "error", error: "FAILED: again" });

		const second = retryDemoJob(chat.id, first.job.id);
		assert.ok(second.ok);
		if (!second.ok) return;
		track(second.job);
		assert.equal(second.created, true);
		assert.equal(second.job.retryOf, first.job.id);
		assert.deepEqual(second.job.input, DEMO_INPUT);
		assert.equal(second.job.toolCallId, failed.toolCallId);
	});

	it("legacy job without saved input: the request comes back from the transcript", () => {
		const spawned = wireRespawn();
		const chat = newChat([
			{ id: "u1", role: "user", content: "teach me compounding", timestamp: 1 } as never,
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "call-legacy", name: "demo", arguments: DEMO_INPUT }],
				api: "openai-completions",
				provider: "openrouter",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
				timestamp: 1,
			} as never,
		]);
		const legacy = jobStore.createJob({ kind: "demo", chatId: chat.id, toolCallId: "call-legacy" });
		createdJobs.push(legacy.id);
		jobStore.updateJob(legacy.id, { status: "error", error: "FAILED: old build" });
		assert.equal(jobStore.getJob(legacy.id)!.input, undefined);

		const outcome = retryDemoJob(chat.id, legacy.id);
		assert.ok(outcome.ok);
		if (!outcome.ok) return;
		track(outcome.job);
		assert.deepEqual(outcome.job.input, DEMO_INPUT, "the new attempt carries the transcript's arguments");
		assert.deepEqual(spawned, [outcome.job.id]);
	});
});

describe("retryDemoJob — start failures", () => {
	it("503 when no respawn is wired, and nothing is created", () => {
		setJobRespawn(undefined as unknown as JobRespawn);
		const chat = newChat();
		const failed = failedJob(chat.id);
		assertFailure(retryDemoJob(chat.id, failed.id), 503);
		assert.equal(jobStore.listJobs(chat.id).length, 1);
	});

	it("503 when respawn throws: the new attempt is marked error, the failed one is untouched", () => {
		setJobRespawn(() => {
			throw new Error("spawn exploded");
		});
		const chat = newChat();
		const failed = failedJob(chat.id);
		const before = structuredClone(jobStore.getJob(failed.id));

		assertFailure(retryDemoJob(chat.id, failed.id), 503);
		const successors = jobStore.listJobs(chat.id).filter((j) => j.retryOf === failed.id);
		assert.equal(successors.length, 1);
		track(successors[0]!);
		assert.equal(successors[0]!.status, "error", "never left running without a worker");
		assert.equal(successors[0]!.error, "spawn exploded");
		assert.deepEqual(jobStore.getJob(failed.id), before);
	});
});

describe("POST /api/jobs", () => {
	it("maps validation to HTTP and returns the new job (201) or the existing successor (200)", async () => {
		const spawned = wireRespawn();
		const chat = newChat();
		const failed = failedJob(chat.id);

		assert.equal((await postJobs("not json")).status, 400);
		assert.equal((await postJobs({ chatId: chat.id })).status, 400);
		assert.equal((await postJobs({ chatId: "chat_nope", jobId: failed.id })).status, 404);
		assert.equal((await postJobs({ chatId: chat.id, jobId: failedJob(chat.id, { toolCallId: "call-r", kind: "research" }).id })).status, 409);

		const created = await postJobs({ chatId: chat.id, jobId: failed.id });
		assert.equal(created.status, 201);
		const { job } = (await created.json()) as { job: JobRecord };
		track(job);
		assert.equal(job.retryOf, failed.id);

		const again = await postJobs({ chatId: chat.id, jobId: failed.id });
		assert.equal(again.status, 200);
		assert.equal(((await again.json()) as { job: JobRecord }).job.id, job.id);
		assert.deepEqual(spawned, [job.id]);
	});
});

describe("one tool part, several attempts — dispatch dedup and delivery", () => {
	it("the store still finds a job for the toolCallId, so a replayed dispatch never spawns or creates", async () => {
		const spawned = wireRespawn();
		const chat = newChat();
		const failed = failedJob(chat.id);
		const retry = retryDemoJob(chat.id, failed.id);
		assert.ok(retry.ok);
		if (!retry.ok) return;
		track(retry.job);
		assert.equal(jobStore.listJobs(chat.id).filter((j) => j.toolCallId === "call-d1").length, 2);
		const found = jobStore.findJobByToolCallId(chat.id, "call-d1");
		assert.ok(found && [failed.id, retry.job.id].includes(found.id));

		const tools = jobTools({
			chatId: chat.id,
			jobStore,
			spawn: () => assert.fail("a replayed dispatch must not spawn a second worker"),
		});
		const result = await tools.demo!.execute("call-d1", DEMO_INPUT, undefined as never);
		assert.match(JSON.stringify(result), /Dispatched \(job /);
		assert.equal(jobStore.listJobs(chat.id).length, 2, "no third job");
		assert.deepEqual(spawned, [retry.job.id]);
	});

	it("the new attempt's outcome is steered under its OWN job id, for the same tool part", async () => {
		const chat = newChat();
		const failed = failedJob(chat.id);
		const steers: SteerMessage[] = [];
		const runner = createJobRunner({ chatStore, jobStore, deliver: async (steer) => void steers.push(steer) });
		// The real wiring: respawn = runner.runJob. No engine is configured in
		// tests, so the worker refuses honestly — and still steers, which is
		// the delivery path every outcome (success included) rides.
		setJobRespawn((jobId) => void runner.runJob(jobId));

		const outcome = retryDemoJob(chat.id, failed.id);
		assert.ok(outcome.ok);
		if (!outcome.ok) return;
		track(outcome.job);
		for (let i = 0; i < 100 && steers.length === 0; i++) await new Promise((r) => setTimeout(r, 20));

		assert.equal(steers.length, 1, "exactly one steer for the new attempt");
		const details = steers[0]!.details as { jobId: string; toolCallId: string };
		assert.equal(details.jobId, outcome.job.id);
		assert.equal(details.toolCallId, failed.toolCallId);
		assert.equal(steers[0]!.id, `steer_${outcome.job.id}`);
		assert.notEqual(steers[0]!.id, `steer_${failed.id}`, "never collides with the failed attempt's steer");
	});

	it("the wake pipeline delivers the new attempt's steer into the chat; the failed attempt is not replayed", async () => {
		const chat = newChat();
		const failed = failedJob(chat.id);
		wireRespawn();
		const outcome = retryDemoJob(chat.id, failed.id);
		assert.ok(outcome.ok);
		if (!outcome.ok) return;
		track(outcome.job);

		const result = { title: "Compounding", html: "<html>ok</html>", tested: true as const, notes: "tested" };
		jobStore.updateJob(outcome.job.id, { result, status: "done", activity: "finished", delivery: { kind: "result", status: "pending" } });
		const { buildSubagentSteer } = await import("../src/core/contracts.ts");
		const steer = buildSubagentSteer(outcome.job, result);

		const fired: string[] = [];
		setTurnRunner(async (chatId, input) => {
			const steersIn = (input as SteerInput).steers as SteerMessage[];
			fired.push(...steersIn.map((s) => s.id));
			const record = chatStore.getChat(chatId)!;
			chatStore.saveMessages(chatId, [...record.messages, ...steersIn.filter((s) => !steerDelivered(record.messages, s.id))] as LhMessage[]);
			return 200;
		});

		await deliverJobResult(steer);
		for (let i = 0; i < 400 && jobStore.getJob(outcome.job.id)!.delivery?.status !== "delivered"; i++) {
			await new Promise((r) => setTimeout(r, 25));
		}

		assert.deepEqual(fired, [`steer_${outcome.job.id}`], "only the new attempt's steer is woken");
		assert.equal(jobStore.getJob(outcome.job.id)!.delivery?.status, "delivered");
		assert.ok(steerDelivered(chatStore.getChat(chat.id)!.messages, `steer_${outcome.job.id}`), "the result reached the chat record");
		assert.equal(jobStore.getJob(failed.id)!.delivery?.status, "delivered", "the failed attempt's delivery history is unchanged");
	});
});
