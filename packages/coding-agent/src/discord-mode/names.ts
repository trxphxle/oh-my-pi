export function discordChannelName(name: string): string {
	const clean = name
		.normalize("NFKC")
		.replace(/[\p{Cc}\p{Cf}]/gu, "")
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}_-]+/gu, "-")
		.replace(/^-+|-+$/g, "");
	if (!clean || clean.length > 100)
		throw new Error("Discord channel names must contain 1–100 letters, numbers, underscores, or hyphens.");
	return clean;
}

export function discordCategoryName(name: string): string {
	const clean = name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
	if (!clean || clean.length > 100) throw new Error("Discord category names must contain 1–100 characters.");
	return clean;
}
