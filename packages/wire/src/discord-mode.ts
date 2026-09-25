/** Shared contracts for Haiso's opt-in Discord session transport. */
export const DISCORD_MODE_DAEMON_NAME = "haiso-discord";
export const DISCORD_MODE_READY = "Haiso Discord mode ready";
export const DISCORD_MODE_PROTOCOL = 2;
export const DISCORD_MODE_MAX_TEXT = 12_000;
/** UTF-8 byte bound for a final reply receipt; worst-case JSON escaping (2x) still fits one IPC frame. */
export const DISCORD_MODE_MAX_REPLY = 96 * 1024;
export const DISCORD_MODE_MAX_PENDING = 32;
export const DISCORD_MODE_MAX_SESSIONS = 128;
export const DISCORD_MODE_MAX_FRAME = 256 * 1024;
/** UTF-8 JSON bound for one reported settings view; it rides a poll only when its revision changed. */
export const DISCORD_MODE_MAX_SETTINGS_BYTES = 48 * 1024;
/** Quick model choices (one Discord select menu). */
export const DISCORD_MODE_MAX_SHORTLIST = 25;
/** Searchable models a session reports; search results are ranked from this list. */
export const DISCORD_MODE_MAX_MODELS = 200;
/** Outstanding owner settings changes per session. */
export const DISCORD_MODE_MAX_SETTING_COMMANDS = 8;
/** Session card progress: `last` label bound and edited-file cap; the tracker never exceeds them. */
export const DISCORD_MODE_MAX_PROGRESS_LABEL = 48;
export const DISCORD_MODE_MAX_PROGRESS_FILES = 999;
/**
 * Longest `/wait` park (ms). A wait refreshes the lease on entry and exit, so it must stay well inside the broker's
 * 45 s lease and the 30 s request deadline.
 */
export const DISCORD_MODE_MAX_WAIT_MS = 25_000;

/**
 * Hidden Haiso CLI selector (the only argument) that starts or adopts the account service, prints
 * DISCORD_MODE_READY, and exits; the OMP bridge runs it when the service is down. Mirrors worker-selectors.ts.
 */
export const DISCORD_MODE_ENSURE_WORKER_ARG = "__omp_worker_discord_ensure";

/** The running account service's build; absent from older services. */
export interface ModeServiceInfo {
	/** Upstream version the release was built on. */
	version: string;
	/** Source commit (12 hex) from the release receipt; absent outside an installed release. */
	commit?: string;
	/** Installed release directory the service runs from; absent outside an installed release. */
	release?: string;
}

/** Private attachment identity; stable across service restarts, never model-visible. */
export interface DiscordModeInfo {
	protocol: typeof DISCORD_MODE_PROTOCOL;
	instanceId: string;
	configKey: string;
	service?: ModeServiceInfo;
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
/** Owner @mention policy for one session; absent means `needs-you`. */
export type ModeNotify = "all" | "needs-you" | "off";
/** Host app that attached a session; absent means `haiso` (older records and Haiso clients omit it). */
export type ModeApp = "haiso" | "omp";
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
	notify?: ModeNotify;
	app?: ModeApp;
	/** Supervisor daemon name of the background copy that holds (or last held) the lease; absent for terminals. */
	host?: string;
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
	/**
	 * Queued but withheld from dispatch until explicitly released (saved while the session was closed, or held by a
	 * binding problem). Absent from older brokers, which strip it.
	 */
	held?: boolean;
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
	/** Final-reply receipt byte bound; absent from older brokers, which accept only DISCORD_MODE_MAX_TEXT. */
	maxReply?: number;
	/**
	 * Revision of this connection's last reported settings view, `""` before the first. Present only from brokers
	 * that accept `settings`/`usage` on poll and `command-result`; older brokers reject those fields.
	 */
	settingsRevision?: string;
	/** Poll only: owner settings changes this connection has not acknowledged yet, oldest first; ids repeat until acked. */
	commands?: ModeSettingCommand[];
	/** Present only from brokers that accept `progress` on poll; older brokers reject the field. */
	progress?: true;
	/** This broker can start conversations in the background (`background` op, Discord resume/new/close). */
	background?: true;
	/** Poll/status only: the owner or a terminal asked this background copy to leave at its next idle point. */
	stepAside?: true;
	/** The service's build, so a client can tell it is running an older release than the one installed. */
	service?: ModeServiceInfo;
	/**
	 * The broker answers `POST /wait {lease, timeoutMs}` with `{ready}` once work for this lease is ready (or the
	 * timeout passes); clients then poll once. Absent from older brokers, whose clients keep polling every second.
	 */
	wait?: true;
}
/** Owner-queued session settings changes. Approval policy, credentials, and logins never cross this boundary. */
export type ModeSettingKind = "model" | "effort" | "default" | "compact" | "advisor" | "advisor-model" | "plan";
export interface ModeSettingCommand {
	id: string;
	kind: ModeSettingKind;
	/** `model`/`advisor-model`: model selector; `effort`: level; `advisor`: on/off. */
	value?: string | boolean;
}
export interface ModeModelChoice {
	/** Canonical `provider/id`. */
	selector: string;
	name: string;
	/** Model role this choice fills (default, smol, slow, …). */
	role?: string;
	/** Effort choices this model supports, in ladder order; empty when it has no effort control. */
	efforts: string[];
}
/** What the session lets a Discord owner see and change; controls follow `capabilities`. */
export interface ModeSettingsView {
	/** Session-computed digest of the rest of the view; the broker echoes it as `settingsRevision`. */
	revision: string;
	model?: ModeModelChoice;
	/** Configured effort: a supported level, `off`, or `auto`. */
	effort?: string;
	advisor?: { enabled: boolean; active: boolean; model?: string };
	plan?: { enabled: boolean };
	capabilities: {
		/** Make default: persist the current model and effort. Session-only otherwise. */
		persist: boolean;
		compact: boolean;
		advisor: boolean;
		plan: boolean;
	};
	/** Quick choices: current, role models, scoped, then recent. */
	shortlist: ModeModelChoice[];
	/** Searchable models in the session's picker order. */
	models: ModeModelChoice[];
}
export interface ModeUsage {
	tokens: number;
	contextWindow: number;
	percent: number;
}
/** Broker-assembled settings panel content. */
export interface ModeSettingsPanel {
	view: ModeSettingsView;
	usage?: ModeUsage;
	busy: boolean;
	/** Outstanding changes, oldest first. */
	pending: ModeSettingCommand[];
	/** Ranked search results when the request carried a query. */
	matches?: ModeModelChoice[];
}
/** What the running tool is doing; compaction and retry override while active. */
export type ModeProgressPhase =
	| "thinking"
	| "reading"
	| "editing"
	| "running"
	| "searching"
	| "delegating"
	| "compacting"
	| "retrying";
/**
 * Live run summary for the session card, built only from tool names, sanitized arguments, and outcomes: never
 * reasoning, tool output, or model-authored intent.
 */
export interface ModeProgress {
	/** Epoch ms the run started. */
	startedAt: number;
	phase: ModeProgressPhase;
	/** Distinct files edited this run, capped at DISCORD_MODE_MAX_PROGRESS_FILES. */
	files: number;
	/** Last notable tool: a shortened command, `edit <path>`, or `task`; plain, at most DISCORD_MODE_MAX_PROGRESS_LABEL. */
	last?: { label: string; outcome: "pass" | "fail" | "timeout" | "started" };
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
			/** Attaching host app; absent means `haiso`. Older brokers reject the field. */
			app?: ModeApp;
			/**
			 * Automatic resume only: refuse unless the broker still has this session enrolled, enabled, and not retired;
			 * never creates a session. Older brokers reject the field.
			 */
			rejoin?: true;
			/**
			 * Single-use claim of a Discord-started launch: a resume must match its conversation; a new conversation takes
			 * the launch's label and project group. Only brokers advertising `background` accept it.
			 */
			launchId?: string;
			/** Sent by a background copy on every registration; brokers advertising `background` accept it. */
			host?: "background";
	  }
	| {
			op: "poll";
			lease: ModeLease;
			busy: boolean;
			pendingInput: boolean;
			/** Only to brokers advertising `settingsRevision`, and only when the revision changed. */
			settings?: ModeSettingsView;
			usage?: ModeUsage;
			/** Only to brokers advertising `progress`, and only while a run is active. */
			progress?: ModeProgress;
	  }
	/** Outcome of one owner settings change, with the fresh view; only to brokers advertising `settingsRevision`. */
	| {
			op: "command-result";
			lease: ModeLease;
			commandId: string;
			outcome: "applied" | "rejected" | "failed";
			text: string;
			settings?: ModeSettingsView;
			usage?: ModeUsage;
	  }
	| { op: "status"; lease: ModeLease }
	| { op: "off"; lease: ModeLease }
	/** Drop this connection but keep sharing enabled, so resuming the conversation rejoins its channel. */
	| { op: "detach"; lease: ModeLease }
	/**
	 * Sticky off by native identity; needs no lease, so it also works while the conversation is not attached.
	 * Refused while another process holds a live lease.
	 */
	| { op: "disable"; sessionId: string; sessionFile: string; projectDir: string }
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
	  }
	/**
	 * Release (`send`, in arrival order) or drop (`discard`) this session's saved owner messages; all of them when
	 * `deliveryIds` is absent. Older brokers reject the op unexecuted.
	 */
	| { op: "held"; lease: ModeLease; requestId: string; action: "send" | "discard"; deliveryIds?: string[] }
	/**
	 * A terminal opening a conversation held by a background copy asks that copy to leave at its next idle point. By
	 * native identity like `disable`; refused unless a background copy holds the live lease.
	 */
	| { op: "step-aside"; sessionId: string; sessionFile: string; projectDir: string }
	/**
	 * Close this terminal but keep the conversation running: the broker starts a background copy for it (which waits
	 * for this process to release the conversation) and drops this connection like `detach`.
	 */
	| { op: "background"; lease: ModeLease };

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
	settings?: ModeSettingsPanel;
	/** A queued settings change; its outcome arrives later through `DiscordPort.settingsResult`. */
	commandId?: string;
	/** The owner message was saved for a closed session; the acknowledgement offers to discard it. */
	saved?: true;
	/** `queued` lists saved messages to review one by one. */
	review?: true;
	/** `sessions`: closed conversations of this project the owner can resume, most recent first. */
	resumable?: Array<{ id: string; label: string }>;
}
export interface ModeControlRequest {
	id: string;
	channelId: string;
	ownerId: string;
	/**
	 * `discard`/`release`: one saved message (`deliveryId`); `send-held`/`discard-held`: every saved message;
	 * `review`: list saved messages, or show one (`deliveryId`). These accept a revoked `connectionId`.
	 * `sessions`/`resume`/`new` work in a project's overview or any of its session channels; `resume` takes
	 * `sessionId` (else this channel's conversation); `new` takes `name`, `message`, and optional `model`. `close`
	 * detaches a background copy at its next idle point. `rename` renames this session's channel to `name` (also while
	 * the conversation is closed).
	 */
	action:
		| "status"
		| "stop"
		| "queue"
		| "cancel"
		| "steer"
		| "notify"
		| "settings"
		| "setting"
		| "discard"
		| "release"
		| "send-held"
		| "discard-held"
		| "review"
		| "sessions"
		| "resume"
		| "new"
		| "close"
		| "rename";
	connectionId?: string;
	deliveryId?: string;
	notify?: ModeNotify;
	/** `setting` only. `model`/`advisor-model` values are choice tokens from the panel, never raw selectors. */
	setting?: { kind: ModeSettingKind; value?: string | boolean };
	/** `settings` only: rank the reported models against this text. */
	query?: string;
	sessionId?: string;
	/**
	 * `new`: the conversation's name, its first owner message, and an optional `provider/model` selector.
	 * `rename`: the channel's new name.
	 */
	name?: string;
	message?: string;
	model?: string;
}
/** One owner message as parsed from Discord; `rejected` carries the refusal text for unsupported content. */
export interface ModeOwnerMessage {
	id: string;
	channelId: string;
	ownerId: string;
	text: string;
	kind: "message" | "steer" | "abort";
	rejected?: string;
}
/** A button on a saved-message notice; the label varies, the action is a session control. */
export interface ModeNoticeAction {
	action: "review" | "send-held" | "discard-held";
	label: string;
}
export interface DiscordPortHandlers {
	ownerMessage(input: ModeOwnerMessage): Promise<ModeControlResult>;
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
	/** Orders the listed children of one category top-to-bottom; unlisted channels are untouched. */
	arrange(categoryId: string, channelIds: string[]): Promise<void>;
	/** Owner reports and notices; chunked into ordinary messages, never mentions. */
	publish(channelId: string, text: string, key: string): Promise<void>;
	/** Final owner reply; one message, long text attached in full. `mention` pings the owner. */
	reply(channelId: string, text: string, key: string, options?: { mention?: boolean }): Promise<void>;
	status(
		channelId: string,
		text: string,
		key: string,
		connectionId?: string,
		messageId?: string,
		existingOnly?: boolean,
		/** Session cards carry the attaching app's color; overview cards omit it. */
		app?: ModeApp,
		/** A closed session card offers [Resume] (owner starts it in the background); ignored with `connectionId`. */
		resumable?: boolean,
	): Promise<string>;
	/** `mention` pings the owner; the broker decides per session notify mode. */
	showDialog(channelId: string, dialog: ModeDialog, options?: { mention?: boolean }): Promise<void>;
	endDialog(channelId: string, dialogId: string): Promise<void>;
	/** Outcome of a queued settings change; never mentions. `panel` refreshes the owner's open panel. */
	settingsResult(channelId: string, commandId: string, text: string, panel?: ModeSettingsPanel): Promise<void>;
	retire(channelId: string, sessionId: string, policy: ModeRetirementPolicy): Promise<void>;
	/** Owner messages after `afterId` (exclusive), oldest first, at most `limit`; parsed exactly like live messages. */
	history(channelId: string, afterId: string, limit: number): Promise<ModeOwnerMessage[]>;
	/** One non-pinging notice with saved-message buttons bound to `connectionId`; `key` makes it idempotent. */
	notice(
		channelId: string,
		text: string,
		key: string,
		connectionId: string,
		actions: ModeNoticeAction[],
	): Promise<void>;
	/**
	 * Maintained pinned guide, the one non-private channel the bot writes to (no session data): the bot's pinned
	 * message whose first line matches `text`'s, in a text channel outside `exclude` categories, else a new one pinned
	 * in a channel named `general`. Edited only when `text` differs; `note` is posted beside it once, never pinging.
	 * Resolves undefined when there is no such channel. Absent from fixtures without a guide.
	 */
	guide?(input: {
		text: string;
		saved?: ModeGuidePlacement;
		exclude: string[];
		note?: { text: string; key: string };
	}): Promise<ModeGuidePlacement | undefined>;
	/** Whether Discord events are still being handled; a service restart waits until they are done. */
	busy?(): boolean;
}
export interface ModeGuidePlacement {
	channelId: string;
	messageId: string;
}
