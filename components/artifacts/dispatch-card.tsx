"use client";

import { useContext, useRef, useState } from "react";
import { CheckIcon, SettingsIcon, XIcon } from "lucide-react";
import { JobsContext } from "@/components/jobs-context";
import { ChatActionsContext } from "@/components/chat";
import { isModelsRefusal, isProviderKeyRefusal, type JobKind, type JobRecord } from "@/src/core";
import { BrailleSpinner } from "@/components/braille-spinner";

/**
 * The dispatch card (contracts.ts "THE ASYNC PROTOCOL" §4): the tool-call
 * box for a background sub-agent. The tool part's output is the FIRE-AND-
 * FORGET ACK (a string) — never the result. Live status comes from the
 * chat-view jobs feed via JobsContext, matched by toolCallId:
 *
 *   job unknown → "dispatched" pulse (the jobs feed hasn't seen it yet)
 *   running     → live activity card (activity line + elapsed)
 *   done/error  → quiet one-liner ("finished" / "failed") — the artifact
 *                 itself arrives in the steer message right below, so the
 *                 box must not duplicate it.
 *
 * A failed demo can be retried (issue #425): the retry is a NEW job for the
 * same toolCallId (JobRecord.retryOf names the attempt it replaces), and the
 * card always follows the newest attempt.
 */
const KIND_LABEL: Record<JobKind, string> = {
	research: "Research agent",
	demo: "Demo agent",
	visual: "Figure agent",
	pdf: "PDF reader",
};

/** The attempt a card follows: among the jobs fulfilling this tool part,
 *  the newest one that no retry has superseded. */
function newestAttempt(jobs: readonly JobRecord[], toolCallId: string): JobRecord | null {
	const attempts = jobs.filter((j) => j.toolCallId === toolCallId);
	const superseded = new Set(attempts.flatMap((j) => (j.retryOf ? [j.retryOf] : [])));
	const current = attempts.filter((j) => !superseded.has(j.id));
	let newest: JobRecord | null = null;
	for (const j of current.length > 0 ? current : attempts) {
		if (!newest || j.createdAt.localeCompare(newest.createdAt) > 0) newest = j;
	}
	return newest;
}

export function DispatchCard({ toolCallId, kind }: { toolCallId: string; kind: JobKind }) {
	const jobs = useContext(JobsContext);
	const job = newestAttempt(jobs, toolCallId);
	const label = KIND_LABEL[kind];

	if (!job || job.status === "running") {
		return <DispatchActivityCard job={job} label={label} />;
	}
	// BYOK (owner, 2026-09-22): a job refused for missing models is INFO,
	// not scary-error — gray glyph + "needs model setup" + the deep-link
	// into the SetupDialog (the same flow the send interception uses).
	// The provider-key refusal twin (zero-keys wave): a pinned model
	// whose key is gone reads as the key being needed — the deep-link
	// lands on the SetupDialog's first-key stage on its own.
	if (isModelsRefusal(job.error)) {
		return <DispatchRefusedCard label={label} line="needs model setup" button="Set up models" />;
	}
	if (isProviderKeyRefusal(job.error)) {
		return <DispatchRefusedCard label={label} line="needs a provider key" button="Add a key" />;
	}
	const failed = job.status === "error";
	return (
		<div
			className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
			data-testid="dispatch-settled"
		>
			{failed ? <XIcon className="size-3.5 text-red-500" /> : <CheckIcon className="size-3.5" />}
			<span className="font-medium uppercase tracking-wide">{label}</span>
			<span>{failed ? "failed" : "finished"}</span>
			{failed && kind === "demo" && <DemoRetry key={job.id} job={job} />}
		</div>
	);
}

/** Retry for a failed demo: asks the server for a fresh attempt from the
 *  original request. After a successful request the button stays "Retrying…"
 *  until the jobs feed brings the new attempt (the card then re-keys); a
 *  failed request leaves the button clickable. */
function DemoRetry({ job }: { job: JobRecord }) {
	const [retrying, setRetrying] = useState(false);
	const [failed, setFailed] = useState(false);
	const inFlight = useRef(false);

	async function retry() {
		if (inFlight.current) return;
		inFlight.current = true;
		setRetrying(true);
		setFailed(false);
		try {
			const res = await fetch("/api/jobs", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId: job.chatId, jobId: job.id }),
			});
			if (!res.ok) throw new Error(`retry failed (${res.status})`);
		} catch {
			inFlight.current = false;
			setRetrying(false);
			setFailed(true);
		}
	}

	return (
		<>
			<button
				type="button"
				data-testid="dispatch-retry"
				disabled={retrying}
				onClick={() => void retry()}
				className="ml-1 rounded-sm border border-border bg-card px-2 py-0.5 font-ui normal-case tracking-normal text-foreground transition-colors hover:border-muted-foreground/50 disabled:cursor-default disabled:opacity-60"
			>
				{retrying ? "Retrying…" : "Retry"}
			</button>
			{failed && (
				<span role="alert" data-testid="dispatch-retry-error" className="text-red-500">
					Could not retry the demo. Try again.
				</span>
			)}
		</>
	);
}

/** The refused card: quiet info tone — nothing red, nothing "failed". */
function DispatchRefusedCard({ label, line, button }: { label: string; line: string; button: string }) {
	const ctx = useContext(ChatActionsContext);
	return (
		<div
			className="flex items-center gap-2 text-xs text-muted-foreground"
			data-testid="dispatch-refused"
		>
			<SettingsIcon className="size-3.5" />
			<span className="font-medium uppercase tracking-wide">{label}</span>
			<span>{line}</span>
			{ctx && (
				<button
					type="button"
					data-testid="dispatch-setup-link"
					onClick={ctx.openSetup}
					className="ml-1 rounded-sm border border-border bg-card px-2 py-0.5 font-ui normal-case tracking-normal text-foreground transition-colors hover:border-muted-foreground/50"
				>
					{button}
				</button>
			)}
		</div>
	);
}

function DispatchActivityCard({ job, label }: { job: JobRecord | null; label: string }) {
	// Elapsed from createdAt — jobs appear here only via the jobs feed (post-mount),
	// so no SSR/hydration mismatch.
	const elapsed =
		job && job.createdAt ? Math.max(0, Math.round((Date.now() - Date.parse(job.createdAt)) / 1000)) : null;
	return (
		<div
			className="rounded-xl border bg-card p-4 text-card-foreground"
			data-testid="dispatch-card"
		>
			<div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{/* The working-state grammar (owner, streaming round 2026-10-01):
				    the Braille spinner replaces the pulsing dot — one indicator
				    everywhere. This is the ONLY dispatch-card change; the card's
				    shape is untouched. */}
				<BrailleSpinner label={`${label} running`} />
				{label}
				{elapsed !== null && <span className="font-normal">· {elapsed}s</span>}
			</div>
			{job?.activity && (
				<div className="mt-1 truncate text-sm text-muted-foreground" data-testid="dispatch-activity-line">
					{job.activity}
				</div>
			)}
			{!job && (
				<div className="mt-1 text-sm text-muted-foreground" data-testid="dispatch-pending">
					Dispatched…
				</div>
			)}
		</div>
	);
}
