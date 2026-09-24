/** Shared contracts for Haiso's opt-in Discord session transport. */
export const DISCORD_MODE_DAEMON_NAME = "haiso-discord";
export const DISCORD_MODE_READY = "Haiso Discord mode ready";
export const DISCORD_MODE_PROTOCOL = 2;
export const DISCORD_MODE_MAX_TEXT = 12_000;
export const DISCORD_MODE_MAX_PENDING = 32;
export const DISCORD_MODE_MAX_SESSIONS = 128;
export const DISCORD_MODE_MAX_FRAME = 256 * 1024;

/** Private attachment identity; stable across service restarts, never model-visible. */
export interface DiscordModeInfo {
	protocol: typeof DISCORD_MODE_PROTOCOL;
	instanceId: string;
	configKey: string;
}

/** Published only after native authenticated adoption of an existing account service. */
export interface DiscordModeConnector {
	version: 1;
	configKey: string;
	supervisor?: {
		endpoint: string;
		tokenPath: string;
		projectDir: string;
	};
}

export interface DiscordModeConfig {
	botToken: string;
	guildId: string;
	ownerId: string;
}

export type BindingState = "ready" | "missing" | "inaccessible" | "moved" | "offline" | "unbound" | "uncertain";
export interface ModeGroup {
	id: string;
	projectDir: string;
	name: string;
	categoryId?: string;
	overviewId?: string;
	state: BindingState;
}
export type ModeRetirementPolicy = "retain" | "delete";
export interface ModeRetirement {
	eventId: string;
	policy: ModeRetirementPolicy;
	deletedAt: number;
	state: "pending" | "done" | "attention";
	channelId?: string;
	error?: string;
}
export interface ModeDeletionBinding {
	sessionId: string;
	sessionFile: string;
	projectDir: string;
	channelId?: string;
	label: string;
	guildId: string;
	ownerId: string;
}
export interface ModeDeletionEvent {
	version: 1;
	id: string;
	binding: ModeDeletionBinding;
	policy: ModeRetirementPolicy;
	phase: "prepared" | "committed";
	createdAt: number;
}
export interface ModeSession {
	id: string;
	groupId: string;
	sessionFile: string;
	projectDir: string;
	label: string;
	channelId?: string;
	connectionId: string;
	enabled: boolean;
	connected: boolean;
	busy: boolean;
	pendingInput: boolean;
	state: BindingState;
	retirement?: ModeRetirement;
}
export interface ModeEnrollment {
	group: ModeGroup;
	session?: ModeSession;
}
export interface ModeLease {
	sessionId: string;
	connectionId: string;
	token: string;
}
export interface ModeDelivery {
	id: string;
	sessionId: string;
	from: string;
	source: "owner" | "peer";
	kind: "message" | "steer" | "abort";
	text: string;
	state: "queued" | "dispatched" | "accepted" | "completed" | "rejected" | "unknown" | "resolved";
	createdAt: number;
}
export interface ModeDialog {
	id: string;
	kind: "select" | "confirm" | "input" | "editor";
	title: string;
	message?: string;
	options?: string[];
	prefill?: string;
}
export interface ModeDialogAnswer {
	id: string;
	value?: string | boolean;
	cancelled: boolean;
}
export interface ModeSnapshot {
	group: ModeGroup;
	session: ModeSession;
	peers: ModeSession[];
	lease?: ModeLease;
	deliveries: ModeDelivery[];
	answers: ModeDialogAnswer[];
	gatewayConnected: boolean;
}
export type ModeRequest =
	| { op: "retire"; eventId: string }
	| {
			op: "register";
			requestId: string;
			sessionId: string;
			sessionFile: string;
			projectDir: string;
			connectionId: string;
			label: string;
			groupName: string;
	  }
	| { op: "poll"; lease: ModeLease; busy: boolean; pendingInput: boolean }
	| { op: "status"; lease: ModeLease }
	| { op: "off"; lease: ModeLease }
	| {
			op: "receipt";
			lease: ModeLease;
			deliveryId: string;
			state: "accepted" | "completed" | "rejected";
			text?: string;
	  }
	| { op: "resolve-delivery"; lease: ModeLease; requestId: string; deliveryId: string }
	| { op: "send"; lease: ModeLease; requestId: string; recipientId: string; text: string }
	| { op: "report"; lease: ModeLease; requestId: string; text: string }
	| { op: "dialog"; lease: ModeLease; dialog: ModeDialog }
	| { op: "dialog-end"; lease: ModeLease; dialogId: string }
	| { op: "rename"; lease: ModeLease; requestId: string; target: "session" | "group"; name: string }
	| {
			op: "repair";
			lease: ModeLease;
			requestId: string;
			target: "session" | "group";
			destinationId?: string;
			resumeQueued: boolean;
	  };

export interface RemoteChannel {
	id: string;
	name: string;
	kind: "category" | "text";
	parentId?: string;
	topic?: string;
	/** Explicit owner/bot-only access, independent of inherited category permissions. */
	private: boolean;
}
export type ChannelInspection = { state: "found"; channel: RemoteChannel } | { state: "missing" | "inaccessible" };
export interface ModeQueuedMessage {
	id: string;
	text: string;
	createdAt: number;
	held: boolean;
	actionable: boolean;
}
export interface ModeControlResult {
	text: string;
	connectionId?: string;
	deliveryId?: string;
	queued?: ModeQueuedMessage[];
}
export interface ModeControlRequest {
	id: string;
	channelId: string;
	ownerId: string;
	action: "status" | "stop" | "queue" | "cancel" | "steer";
	connectionId?: string;
	deliveryId?: string;
}
export interface DiscordPortHandlers {
	ownerMessage(input: {
		id: string;
		channelId: string;
		ownerId: string;
		text: string;
		kind: "message" | "steer" | "abort";
		rejected?: string;
	}): Promise<ModeControlResult>;
	control(input: ModeControlRequest): Promise<ModeControlResult>;
	answer(input: {
		channelId: string;
		ownerId: string;
		dialogId: string;
		value?: string | boolean;
		cancelled: boolean;
	}): Promise<string>;
	changed(): Promise<void>;
	connection(connected: boolean): void;
}
/** Discord API adapter; production and offline fixture implement the same boundary. */
export interface DiscordPort {
	start(handlers: DiscordPortHandlers): Promise<void>;
	close(): Promise<void>;
	inspect(id: string): Promise<ChannelInspection>;
	createCategory(name: string): Promise<RemoteChannel>;
	createChannel(categoryId: string, name: string, marker: string): Promise<RemoteChannel>;
	rename(id: string, name: string): Promise<void>;
	move(id: string, categoryId: string): Promise<void>;
	publish(channelId: string, text: string, key: string): Promise<void>;
	status(
		channelId: string,
		text: string,
		key: string,
		connectionId?: string,
		messageId?: string,
		existingOnly?: boolean,
	): Promise<string>;
	showDialog(channelId: string, dialog: ModeDialog): Promise<void>;
	endDialog(channelId: string, dialogId: string): Promise<void>;
	retire(channelId: string, sessionId: string, policy: ModeRetirementPolicy): Promise<void>;
}
