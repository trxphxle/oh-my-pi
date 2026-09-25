import { createHash } from "node:crypto";
import template from "./guide.md" with { type: "text" };

/** Discord's message limit; the guide is one message. */
export const DISCORD_GUIDE_MAX_LENGTH = 2_000;

/** One `/session` subcommand as the guide lists it. */
export interface DiscordGuideCommand {
	name: string;
	description: string;
	/** Values of its choice option, e.g. `all|needs-you|off`. */
	choices: string[];
}

/** The rendered pinned guide, plus what a later release's what's-new note compares against. */
export interface DiscordGuide {
	text: string;
	/** sha256 of `text`. */
	hash: string;
	commands: string[];
	sections: string[];
}

/** Fills the template's `{{commands}}` with the registered `/session` subcommands. */
export function renderDiscordGuide(commands: readonly DiscordGuideCommand[], source: string = template): DiscordGuide {
	const lines = commands.map(
		command =>
			`• \`/session ${command.name}${command.choices.length ? ` ${command.choices.join("|")}` : ""}\` — ${command.description}`,
	);
	const text = source.trim().replace("{{commands}}", lines.join("\n"));
	if (text.length > DISCORD_GUIDE_MAX_LENGTH)
		throw new Error(`Discord guide exceeds one message (${text.length}/${DISCORD_GUIDE_MAX_LENGTH} characters).`);
	return {
		text,
		hash: createHash("sha256").update(text).digest("hex"),
		commands: commands.map(command => command.name),
		// Bold-only lines after the header are section titles.
		sections: text
			.split("\n")
			.slice(1)
			.flatMap(line => /^\*\*([^*]+)\*\*$/.exec(line.trim())?.[1] ?? []),
	};
}

/** The one short note after an update changed the guide; names added subcommands and sections when there are any. */
export function discordGuideWhatsNew(
	previous: { commands?: readonly string[]; sections?: readonly string[] },
	next: DiscordGuide,
): string {
	const added = [
		...next.commands.filter(name => !previous.commands?.includes(name)).map(name => `\`/session ${name}\``),
		...next.sections.filter(title => !previous.sections?.includes(title)),
	];
	return added.length ? `Haiso updated · new: ${added.join(", ")}` : "Haiso updated · the pinned guide was revised";
}
