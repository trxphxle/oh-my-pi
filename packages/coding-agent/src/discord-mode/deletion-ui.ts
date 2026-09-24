import { HookSelectorComponent } from "@oh-my-pi/pi-tui/overlays/hook-selector";
import type { SessionDeleteChoice } from "@oh-my-pi/pi-tui/overlays/session-selector";
import type { InteractiveModeContext } from "../modes/types";
import type { ModeRetirementPolicy } from "@oh-my-pi/pi-wire/discord-mode";
import { lookupDiscordDeletionBinding } from "./retirement-events";

/** A local saved binding is sufficient; deletion never waits for the bot. */
export async function getDiscordDeletionChoices(session: { path: string }): Promise<SessionDeleteChoice[] | undefined> {
	if (!(await lookupDiscordDeletionBinding(session.path))) return undefined;
	return [
		{
			value: "retain",
			label: "Delete local session; retain Discord history",
			description: "Close the Discord conversation without erasing its history.",
		},
		{
			value: "delete",
			label: "Delete local session and Discord channel",
			description: "Permanently erase the Discord channel and all its history. This cannot be undone.",
		},
	];
}

export function discordDeletionPolicy(choice?: string): ModeRetirementPolicy {
	if (choice === undefined || choice === "retain") return "retain";
	if (choice === "delete") return "delete";
	throw new Error("Unknown Discord deletion choice");
}

/** Returns null on cancellation. Non-enrolled sessions preserve their existing confirmation flow. */
export async function chooseDiscordDeletionPolicy(
	ctx: Pick<InteractiveModeContext, "showHookCustom">,
	sessionFile: string,
	confirmUnbound?: () => Promise<boolean>,
): Promise<ModeRetirementPolicy | null> {
	const choices = await getDiscordDeletionChoices({ path: sessionFile });
	if (!choices) return !confirmUnbound || (await confirmUnbound()) ? "retain" : null;
	// Ownership decisions must never be mirrored to Discord or collaboration peers.
	return ctx.showHookCustom<ModeRetirementPolicy | null>(
		(tui, _theme, _keybindings, done) =>
			new HookSelectorComponent(
				"Permanently delete this session?",
				[...choices, "Cancel"],
				label => {
					const choice = choices.find(choice => choice.label === label);
					done(choice ? discordDeletionPolicy(choice.value) : null);
				},
				() => done(null),
				{ tui },
			),
	);
}
