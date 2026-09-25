import type { ModeApp } from "@oh-my-pi/pi-wire/discord-mode";

/** Leading session channel-name marker per attaching app; broker labels never carry it. */
export const SESSION_MARKERS: Record<ModeApp, string> = { haiso: "🟣", omp: "🔵" };
/** One or more known leading markers (optionally emoji-presented) and their separators. */
const MARKED = /^(?:(🟣|🔵)\uFE0F?[-\s]*)+/u;

/** Discord text-channel slug; a known leading app marker survives as `<marker>-<slug>`. */
export function discordChannelName(name: string): string {
	const trimmed = name
		.normalize("NFKC")
		.replace(/[\p{Cc}\p{Cf}]/gu, "")
		.trim();
	const marked = MARKED.exec(trimmed);
	const clean = trimmed
		.slice(marked?.[0].length ?? 0)
		.toLowerCase()
		.replace(/[^\p{L}\p{N}_-]+/gu, "-")
		.replace(/^-+|-+$/g, "");
	const marker = marked?.[1];
	if (!clean || clean.length > (marker ? 100 - marker.length - 1 : 100))
		throw new Error("Discord channel names must contain 1–100 letters, numbers, underscores, or hyphens.");
	return marker ? `${marker}-${clean}` : clean;
}

/** Session label as owned by the broker: channel name without app markers; undefined when nothing remains. */
export function sessionLabel(channelName: string): string | undefined {
	return channelName.trim().replace(MARKED, "").trim() || undefined;
}

/** Unmarked session slug, capped so either 2-unit marker plus `-` fits Discord's 100-character limit. */
export function sessionSlug(label: string): string {
	return discordChannelName(sessionLabel(label) ?? "")
		.slice(0, 97)
		.replace(/-+$/, "");
}

/** Marked session channel name: `🟣-backend` (Haiso) or `🔵-backend` (OMP); throws when the label has no usable slug. */
export function sessionChannelName(label: string, app: ModeApp = "haiso"): string {
	return `${SESSION_MARKERS[app]}-${sessionSlug(label)}`;
}

export function discordCategoryName(name: string): string {
	const clean = name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
	if (!clean || clean.length > 100) throw new Error("Discord category names must contain 1–100 characters.");
	return clean;
}
