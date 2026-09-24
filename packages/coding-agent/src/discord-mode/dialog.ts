import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionAskDialogResultItem,
} from "../extensibility/extensions";
import type { ModeDialog, ModeDialogAnswer } from "@oh-my-pi/pi-wire/discord-mode";

export type DiscordDialogResult = { kind: "answered"; value: string | boolean | undefined } | { kind: "unavailable" };

/** Transport loss withdraws the remote participant; it never answers the local dialog. */
export async function raceDiscordDialog<T>(
	remote: (signal: AbortSignal) => Promise<{ kind: "answered"; value: T } | { kind: "unavailable" }>,
	local: (signal: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	const localAbort = new AbortController();
	const remoteAbort = new AbortController();
	const localSignal = signal ? AbortSignal.any([signal, localAbort.signal]) : localAbort.signal;
	const remoteSignal = signal ? AbortSignal.any([signal, remoteAbort.signal]) : remoteAbort.signal;
	const localWinner = local(localSignal);
	const remoteWinner = remote(remoteSignal).then<T>(result =>
		result.kind === "unavailable" ? localWinner : result.value,
	);
	try {
		return await Promise.race([localWinner, remoteWinner]);
	} finally {
		localAbort.abort();
		remoteAbort.abort();
	}
}

interface PendingDialog {
	dialog: ModeDialog;
	finish: (result: DiscordDialogResult) => void;
}

/** Native IDs are per presentation, not per title; a stale click cannot answer a newer ask. */
export class DiscordDialogs {
	#pending = new Map<string, PendingDialog>();
	constructor(
		private publish: (dialog: ModeDialog) => Promise<void>,
		private end: (id: string) => Promise<void>,
		private changed: () => void,
	) {}

	get pending(): boolean {
		return this.#pending.size > 0;
	}

	request(draft: Omit<ModeDialog, "id">, signal?: AbortSignal): Promise<DiscordDialogResult> {
		if (signal?.aborted || this.#pending.size >= 8) return Promise.resolve({ kind: "unavailable" });
		const dialog: ModeDialog = { ...draft, id: crypto.randomUUID() };
		const { promise, resolve } = Promise.withResolvers<DiscordDialogResult>();
		const published = Promise.withResolvers<void>();
		const onAbort = () => finish({ kind: "unavailable" });
		const finish = (result: DiscordDialogResult) => {
			if (!this.#pending.delete(dialog.id)) return;
			signal?.removeEventListener("abort", onAbort);
			this.changed();
			resolve(result);
			void published.promise.then(() => this.end(dialog.id)).catch(() => {});
		};
		this.#pending.set(dialog.id, { dialog, finish });
		signal?.addEventListener("abort", onAbort, { once: true });
		this.changed();
		if (this.#pending.has(dialog.id)) {
			void Promise.try(() => this.publish(dialog)).then(published.resolve, published.reject);
		} else {
			published.resolve();
		}
		void published.promise.catch(() => finish({ kind: "unavailable" }));
		return promise;
	}

	answer(answer: ModeDialogAnswer): void {
		const pending = this.#pending.get(answer.id);
		if (!pending) return;
		if (answer.cancelled) {
			pending.finish({ kind: "answered", value: undefined });
			return;
		}
		const { dialog } = pending;
		if (dialog.kind === "confirm") {
			if (typeof answer.value !== "boolean") return;
		} else {
			if (typeof answer.value !== "string") return;
			if (dialog.kind === "select" && !dialog.options?.includes(answer.value)) return;
		}
		pending.finish({ kind: "answered", value: answer.value });
	}

	unavailable(): void {
		for (const pending of this.#pending.values()) pending.finish({ kind: "unavailable" });
	}
}

/** Lossless selector/editor projection: control rows cannot collide with an option's actual label. */
export async function requestDiscordAsk(
	questions: ExtensionAskDialogQuestion[],
	request: (dialog: Omit<ModeDialog, "id">, signal: AbortSignal) => Promise<DiscordDialogResult>,
	signal: AbortSignal,
): Promise<{ kind: "answered"; value: ExtensionAskDialogResult | undefined } | { kind: "unavailable" }> {
	const results: ExtensionAskDialogResultItem[] = [];
	for (const question of questions) {
		const selected = new Set<number>();
		let customInput: string | undefined;
		let note: string | undefined;
		while (!signal.aborted) {
			const options = question.options.map(
				(option, index) =>
					`[${index + 1}] ${selected.has(index) ? "(selected) " : ""}${option.label}${question.recommended === index ? " (recommended)" : ""}${option.description ? `\n${option.description}` : ""}${option.preview ? `\n${option.preview}` : ""}`,
			);
			const custom = "[custom] Other (type your own)";
			const chat = "[chat] Chat about this";
			const annotate = "[note] Add or edit answer note";
			const next = "[next] Submit this answer";
			const rows = [...options, custom, chat, annotate];
			if (selected.size || customInput !== undefined) rows.push(next);
			const choice = await request(
				{
					kind: "select",
					title: question.header ? `${question.header}\n${question.question}` : question.question,
					message: `${question.multi ? "Toggle options, then submit." : "Select an option, then submit."}${customInput !== undefined ? `\nCustom answer: ${customInput}` : ""}${note !== undefined ? `\nNote: ${note}` : ""}`,
					options: rows,
				},
				signal,
			);
			if (choice.kind === "unavailable") return choice;
			if (choice.value === undefined) return { kind: "answered", value: undefined };
			if (choice.value === chat) return { kind: "answered", value: { kind: "chat" } };
			if (choice.value === next && (selected.size || customInput !== undefined)) break;
			if (choice.value === custom || choice.value === annotate) {
				const answer = await request(
					{
						kind: "editor",
						title: `${choice.value === custom ? "Custom answer" : "Answer note"}: ${question.question}`,
						prefill: choice.value === custom ? customInput : note,
					},
					signal,
				);
				if (answer.kind === "unavailable") return answer;
				if (typeof answer.value === "string") {
					if (choice.value === custom) {
						customInput = answer.value;
						if (!question.multi) selected.clear();
					} else note = answer.value;
				}
				continue;
			}
			const index = typeof choice.value === "string" ? options.indexOf(choice.value) : -1;
			if (index < 0) continue;
			if (question.multi && selected.has(index)) selected.delete(index);
			else {
				if (!question.multi) {
					selected.clear();
					customInput = undefined;
				}
				selected.add(index);
			}
		}
		if (signal.aborted) return { kind: "unavailable" };
		results.push({
			id: question.id,
			question: question.question,
			options: question.options.map(option => option.label),
			multi: question.multi ?? false,
			selectedOptions: question.options.filter((_option, index) => selected.has(index)).map(option => option.label),
			customInput,
			note,
		});
	}
	return { kind: "answered", value: { kind: "submit", results } };
}
