// Haiso's Discord settings host: what the owner may see and change on a live interactive session.
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { createModelMentionSource } from "@oh-my-pi/pi-tui/prompt/model-mention-autocomplete";
import { modelMentionDisplayName } from "@oh-my-pi/pi-tui/prompt/model-mention-syntax";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import {
	DISCORD_MODE_MAX_MODELS,
	DISCORD_MODE_MAX_SHORTLIST,
	type ModeModelChoice,
	type ModeSettingCommand,
	type ModeSettingsView,
} from "@oh-my-pi/pi-wire/discord-mode";
import { createModelBrowserSource } from "../modes/model-browser-source";
import type { InteractiveModeContext } from "../modes/types";
import type { DiscordSettingResult, DiscordSettingsHost } from "./session";

const selectorOf = (model: Model) => `${model.provider}/${model.id}`;

/** The TUI's effort ladder for one model: off, auto, then its supported levels; empty without an effort control. */
export function discordEffortLadder(model: Model): string[] {
	const efforts = model.reasoning ? getSupportedEfforts(model) : [];
	return efforts.length ? [ThinkingLevel.Off, AUTO_THINKING, ...efforts] : [];
}

const applied = (text: string): DiscordSettingResult => ({ outcome: "applied", text });
const rejected = (text: string): DiscordSettingResult => ({ outcome: "rejected", text });
const failed = (text: string): DiscordSettingResult => ({ outcome: "failed", text });

/**
 * Bound to the engine that exists now: a TUI that moved to another engine reports nothing and refuses changes.
 * Model and effort changes are session-only, like the TUI's session model switch; only "make default" persists.
 */
export function createDiscordSettingsHost(ctx: InteractiveModeContext): DiscordSettingsHost {
	const engine = ctx.session;
	const session = () => (ctx.session === engine ? engine : undefined);
	const available = (selector: unknown) =>
		typeof selector === "string"
			? engine.modelRegistry.getAvailable().find(model => selectorOf(model) === selector)
			: undefined;
	const refreshChrome = () => {
		ctx.statusLine.invalidate();
		ctx.updateEditorBorderColor();
	};

	return {
		view() {
			const current = session();
			const model = current?.model;
			if (!current || !model) return undefined;
			const settings = current.settings;
			const roles = new Map<string, string>();
			const cycle = current.getRoleModelCycle(settings.get("cycleOrder"));
			for (const entry of cycle?.models ?? [])
				if (!roles.has(selectorOf(entry.model))) roles.set(selectorOf(entry.model), entry.role);
			const choice = (item: Model): ModeModelChoice => {
				const role = roles.get(selectorOf(item));
				return {
					selector: selectorOf(item),
					name: modelMentionDisplayName(item),
					...(role ? { role } : {}),
					efforts: discordEffortLadder(item),
				};
			};
			// The same candidates and order as the TUI's session model picker: roles, recent, then provider/version.
			const ordered = createModelMentionSource({
				source: createModelBrowserSource(settings),
				registry: current.modelRegistry,
				scopedModels: () => current.scopedModels.map(scoped => scoped.model),
			})("").map(item => item.model);
			const unique = (models: Model[], limit: number) => {
				const seen = new Set<string>();
				const result: ModeModelChoice[] = [];
				for (const item of models) {
					if (result.length === limit) break;
					if (seen.has(selectorOf(item))) continue;
					seen.add(selectorOf(item));
					result.push(choice(item));
				}
				return result;
			};
			const configured = current.configuredThinkingLevel();
			const stats = current.getAdvisorStats();
			const advisorModel = stats.model ? selectorOf(stats.model) : settings.getModelRole("advisor");
			return {
				model: choice(model),
				...(configured
					? { effort: configured === ThinkingLevel.Inherit ? ThinkingLevel.Off : String(configured) }
					: {}),
				advisor: {
					enabled: current.isAdvisorEnabled(),
					active: current.isAdvisorActive(),
					...(advisorModel ? { model: advisorModel } : {}),
				},
				plan: { enabled: ctx.planModeEnabled },
				capabilities: {
					// Project role storage has shadowing rules the local /model hub owns.
					persist: settings.get("modelRoleStorage") !== "project",
					compact: true,
					advisor: true,
					plan: settings.get("plan.enabled"),
				},
				shortlist: unique(
					[model, ...(cycle?.models.map(entry => entry.model) ?? []), ...ordered],
					DISCORD_MODE_MAX_SHORTLIST,
				),
				models: unique(ordered, DISCORD_MODE_MAX_MODELS),
			} satisfies Omit<ModeSettingsView, "revision">;
		},

		usage() {
			const usage = session()?.getContextUsage();
			return usage
				? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
				: undefined;
		},

		async apply(command: ModeSettingCommand) {
			const current = session();
			if (!current) return rejected("Not applied: this terminal moved on to another session.");
			switch (command.kind) {
				case "model": {
					const model = available(command.value);
					if (!model) return rejected(`Not applied: ${String(command.value)} is no longer available here.`);
					const name = modelMentionDisplayName(model);
					const apply = async () => {
						await current.setModelTemporary(model, current.resolveTemporaryModelThinkingLevel(model));
						refreshChrome();
					};
					// Like the TUI's session switch: compact first when the transcript exceeds the target's window.
					const tokens = current.getContextUsage()?.tokens ?? 0;
					const window = model.contextWindow ?? 0;
					if (!(window > 0 && tokens > window)) {
						await apply();
						return applied(`Model → ${name} (this session only).`);
					}
					let switched = false;
					const afterCompaction = async (outcome: CompactionOutcome) => {
						if (switched || outcome !== "ok") return;
						switched = true;
						await apply();
					};
					await afterCompaction(await ctx.handleCompactCommand(undefined, undefined, afterCompaction));
					return switched
						? applied(`Model → ${name} (this session only); compacted first to fit its context window.`)
						: failed(`Not applied: compacting to fit ${name}'s context window did not finish.`);
				}
				case "effort": {
					const model = current.model;
					const level = String(command.value);
					if (!model || !discordEffortLadder(model).includes(level))
						return rejected(
							`Not applied: ${model ? modelMentionDisplayName(model) : "this model"} doesn't support effort ${level}.`,
						);
					current.setThinkingLevel(level as ConfiguredThinkingLevel);
					refreshChrome();
					return applied(`Effort → ${current.configuredThinkingLevel() ?? level}.`);
				}
				case "default": {
					const model = current.model;
					if (!model) return rejected("Not applied: this session has no model yet.");
					if (current.settings.get("modelRoleStorage") === "project")
						return rejected(
							"Not applied: model roles are stored per project here; set the default locally with /model.",
						);
					// Mirrors the /model hub's global default assignment.
					const configured = current.configuredThinkingLevel();
					const auto = configured === AUTO_THINKING;
					const concrete = auto || configured === undefined ? undefined : configured;
					await current.setModel(model, "default", {
						selector: selectorOf(model),
						thinkingLevel: auto ? ThinkingLevel.Inherit : concrete,
						persist: true,
					});
					if (auto) current.setThinkingLevel(AUTO_THINKING, true);
					else if (concrete && concrete !== ThinkingLevel.Inherit) current.setThinkingLevel(concrete);
					refreshChrome();
					return applied(
						`Default model → ${modelMentionDisplayName(model)}${configured ? ` · effort ${configured}` : ""}.`,
					);
				}
				case "compact": {
					if (current.isCompacting) return rejected("Not applied: a compaction is already running.");
					const outcome = await ctx.handleCompactCommand();
					if (outcome === "ok") return applied("Context compacted.");
					return outcome === "cancelled"
						? rejected("Compaction was cancelled.")
						: failed("Compaction failed; see the session.");
				}
				case "advisor": {
					if (command.value !== true) {
						current.setAdvisorEnabled(false);
						return applied("Advisor off.");
					}
					return current.setAdvisorEnabled(true)
						? applied("Advisor on.")
						: applied("Advisor setting on, but no model is assigned to the 'advisor' role.");
				}
				case "advisor-model": {
					const model = available(command.value);
					if (!model) return rejected(`Not applied: ${String(command.value)} is no longer available here.`);
					// Runtime role override: this process only, never written to settings.
					current.settings.overrideModelRoles({ advisor: selectorOf(model) });
					return applied(`Advisor model → ${modelMentionDisplayName(model)} (this session only).`);
				}
				case "plan": {
					if (ctx.planModeEnabled) return applied("Plan mode is already on.");
					if (ctx.goalModeEnabled || ctx.goalModePaused) return rejected("Not applied: exit goal mode first.");
					if (ctx.vibeModeEnabled) return rejected("Not applied: exit vibe mode first.");
					if (!current.settings.get("plan.enabled"))
						return rejected("Not applied: plan mode is disabled in settings (plan.enabled).");
					// A paused plan (left without approval) takes one toggle to clear before the next one enters.
					for (let attempt = 0; attempt < 2 && !ctx.planModeEnabled; attempt++) await ctx.handlePlanModeCommand();
					return ctx.planModeEnabled
						? applied("Plan mode on. Leaving it goes through plan approval.")
						: failed("Plan mode didn't start; see the session.");
				}
			}
		},
	};
}
