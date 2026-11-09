/**
 * The input a background job runs on — ONE resolution rule shared by the
 * job runner (recovery, re-spawn) and the demo retry path. Pure and
 * browser-safe: callers pass the chat's messages in.
 */
import type { JobRecord } from "./contracts.ts";

/**
 * Dispatch input wins, then the job's saved arguments. Legacy jobs without
 * saved input fall back to the durable transcript (the arguments of the
 * toolCall block this job fulfills), which may lack a call if the
 * dispatching turn died before settlement.
 */
export function resolveJobInput<T = unknown>(
	job: Pick<JobRecord, "toolCallId" | "input">,
	messages: readonly unknown[] | undefined,
	passed?: T,
): T | undefined {
	if (passed) return passed;
	if (job.input !== undefined) return job.input as T;
	if (!messages) return undefined;
	// The record is native history: a toolCall block's arguments are the input.
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content as Array<{ type?: string; id?: string; arguments?: unknown }>) {
			if (block.type !== "toolCall" || block.id !== job.toolCallId) continue;
			return block.arguments as T | undefined;
		}
	}
	return undefined;
}
