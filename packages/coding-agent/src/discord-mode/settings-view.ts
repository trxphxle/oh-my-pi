// Pure helpers shared by the broker and the Discord adapter for session settings panels.
import { createHash } from "node:crypto";
import { fuzzyRank } from "@oh-my-pi/pi-tui/fuzzy";
import type { ModeModelChoice, ModeSettingCommand, ModeSettingsView } from "@oh-my-pi/pi-wire/discord-mode";

/** Select-menu value for a model choice: Discord caps values at 100 characters, selectors run to 200. */
export function settingsChoiceToken(selector: string): string {
	return createHash("sha256").update(selector).digest("hex").slice(0, 16);
}

/** Every model the view offers, current first, each selector once. */
function choices(view: ModeSettingsView): ModeModelChoice[] {
	const seen = new Set<string>();
	const result: ModeModelChoice[] = [];
	for (const choice of [...(view.model ? [view.model] : []), ...view.shortlist, ...view.models])
		if (!seen.has(choice.selector)) {
			seen.add(choice.selector);
			result.push(choice);
		}
	return result;
}

export function findSettingsChoice(view: ModeSettingsView, token: string): ModeModelChoice | undefined {
	return choices(view).find(choice => settingsChoiceToken(choice.selector) === token);
}

export function findSettingsModel(view: ModeSettingsView, selector: string): ModeModelChoice | undefined {
	return choices(view).find(choice => choice.selector === selector);
}

/** Lowercased letters and digits only, like the TUI model picker's relevance tiers. */
function compact(value: string): string {
	return value.toLowerCase().replace(/[^\p{Letter}\p{Mark}\p{Number}]+/gu, "");
}

/**
 * The TUI picker's relevance tiers (exact id/selector, contiguous, fuzzy-only), then fuzzy quality, then the
 * session's own picker order, which already puts role models and recent models first.
 */
export function rankSettingsModels(
	models: readonly ModeModelChoice[],
	query: string,
	limit: number,
): ModeModelChoice[] {
	const key = compact(query);
	const order = new Map(models.map((choice, index) => [choice, index]));
	const tier = (choice: ModeModelChoice) => {
		const id = compact(choice.selector.slice(choice.selector.indexOf("/") + 1));
		const selector = compact(choice.selector);
		if (key === id || key === selector) return 0;
		return id.includes(key) || selector.includes(key) ? 1 : 2;
	};
	return fuzzyRank(models, query, choice => `${choice.selector} ${choice.name}`)
		.map(result => ({ choice: result.item, tier: tier(result.item), bucket: Math.round(result.score / 10) }))
		.sort((a, b) => a.tier - b.tier || a.bucket - b.bucket || (order.get(a.choice) ?? 0) - (order.get(b.choice) ?? 0))
		.slice(0, limit)
		.map(item => item.choice);
}

/** One-line owner-facing description of a queued change. */
export function describeSettingCommand(command: ModeSettingCommand, view?: ModeSettingsView): string {
	const name = (selector: unknown) =>
		typeof selector === "string" ? ((view && findSettingsModel(view, selector)?.name) ?? selector) : "?";
	switch (command.kind) {
		case "model":
			return `model → ${name(command.value)}`;
		case "effort":
			return `effort → ${String(command.value)}`;
		case "default":
			return "make the current model and effort the default";
		case "compact":
			return "compact the context";
		case "advisor":
			return `advisor ${command.value === true ? "on" : "off"}`;
		case "advisor-model":
			return `advisor model → ${name(command.value)}`;
		case "plan":
			return "enter plan mode";
	}
}
