import { replaceTabs } from "@oh-my-pi/pi-tui";
import type { BindingState, ModeSnapshot } from "@oh-my-pi/pi-wire/discord-mode";

export interface DiscordModePresentation {
	state: "off" | "connected" | "disconnected" | "repair" | "held";
	title: string;
	detail: string;
	footer: string;
	destination?: string;
}

const BINDING_REASONS: Record<BindingState, string> = {
	ready: "Connected",
	missing: "Missing Discord channel or category",
	inaccessible: "Discord access or permissions changed",
	moved: "Discord channel moved",
	offline: "Discord connection lost",
	unbound: "Discord channel not linked",
	uncertain: "Discord changes need inspection",
};

/** One state vocabulary for the command picker, details, and persistent indicator. */
export function describeDiscordMode(options: {
	enabled: boolean;
	snapshot?: ModeSnapshot;
	transportAvailable?: boolean;
	intakeHeld?: boolean;
	pendingInput?: boolean;
	working?: boolean;
}): DiscordModePresentation {
	if (!options.enabled) {
		return {
			state: "off",
			title: "Discord OFF",
			detail: "This session is not shared with Discord.",
			footer: "[Discord OFF]  /discord to connect",
		};
	}
	const snapshot = options.snapshot;
	const destination = snapshot
		? `${replaceTabs(snapshot.group.name)} / #${replaceTabs(snapshot.session.label)}`
		: undefined;
	let state: DiscordModePresentation["state"];
	let title: string;
	let detail: string;
	if (
		!options.transportAvailable ||
		!snapshot ||
		!snapshot.gatewayConnected ||
		!snapshot.session.connected ||
		!snapshot.session.enabled
	) {
		state = "disconnected";
		title = "Discord ON · DISCONNECTED";
		detail =
			!options.transportAvailable || !snapshot
				? "Cannot reach the local bridge. Local work continues; turn off, then on to reconnect."
				: !snapshot.gatewayConnected
					? "Discord is unavailable. Check the network or bot access; local work continues."
					: "This session lost its connection. Turn off, then on to reconnect.";
	} else if (snapshot.group.state !== "ready" || snapshot.session.state !== "ready") {
		state = "repair";
		title = "Discord ON · NEEDS REPAIR";
		const binding = snapshot.group.state !== "ready" ? snapshot.group.state : snapshot.session.state;
		detail = `${BINDING_REASONS[binding]}. Repair the link; local work is unaffected.`;
	} else if (options.intakeHeld || snapshot.deliveries.some(delivery => delivery.state === "unknown")) {
		state = "held";
		title = "Discord ON · ACTION NEEDED";
		detail = "Message delivery is paused. Inspect uncertain work before sending it again.";
	} else {
		state = "connected";
		title = "Discord ON · CONNECTED";
		detail = "Remote messages can reach this session.";
	}
	const activity = options.pendingInput ? "Awaiting your answer" : options.working ? "Working" : undefined;
	return {
		state,
		title,
		detail,
		destination,
		footer: [`[${title}]`, ...(destination ? [destination] : []), ...(activity ? [activity] : [])].join("  ·  "),
	};
}
