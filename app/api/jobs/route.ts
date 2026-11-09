import { isTurnRunning, listJobs, retryDemoJob } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * Job status endpoint (contracts.ts "THE ASYNC PROTOCOL" §4): the chat
 * view's jobs fetch lands here — once on mount, per jobs-changed
 * announcement (the store emits post-write, debounced client-side), and
 * on channel resync (push-architecture S4, 2026-10-02 — the old interval
 * poll is retired). It drives the dispatch cards, the sub-agents panel,
 * and the re-sync when a job settles. `turnInFlight` rides along for the
 * settle logic's idle check.
 */
export async function GET(req: Request) {
	const chatId = new URL(req.url).searchParams.get("chatId");
	if (!chatId) {
		return Response.json({ error: "chatId query parameter is required" }, { status: 400 });
	}
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) {
		return Response.json({ error: "Invalid chatId" }, { status: 400 });
	}
	return Response.json({ jobs: listJobs(chatId), turnInFlight: isTurnRunning(chatId) });
}

/**
 * Retry a failed demo (issue #425): body {chatId, jobId} names the failed
 * attempt. Starts a fresh attempt from its original request and returns the
 * new job; a repeated request returns the same successor. The status codes
 * come straight from retryDemoJob's validation.
 */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { chatId?: unknown; jobId?: unknown } | null;
	if (!body || typeof body !== "object") {
		return Response.json({ error: "A JSON body with chatId and jobId is required" }, { status: 400 });
	}
	const outcome = retryDemoJob(body.chatId, body.jobId);
	if (!outcome.ok) return Response.json({ error: outcome.error }, { status: outcome.status });
	return Response.json({ job: outcome.job }, { status: outcome.created ? 201 : 200 });
}
