import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { canonicalProjectDir } from "../launch/paths";
import { discordCategoryName, sessionChannelName, sessionLabel, sessionSlug } from "./names";
import { ensurePrivateDirectory, readPrivateJson, writePrivateJson } from "@oh-my-pi/pi-utils/discord-private-files";
import { formatDiscordProgressLine } from "@oh-my-pi/pi-utils/discord-progress";
import {
	discardDiscordDeletionEvent,
	isDiscordDeletedSessionFile,
	readDiscordDeletionEvents,
	withDiscordDeletionLock,
} from "./retirement-events";
import { type DiscordGuide, discordGuideWhatsNew } from "./guide";
import { describeSettingCommand, findSettingsChoice, findSettingsModel, rankSettingsModels } from "./settings-view";
import {
	DISCORD_MODE_MAX_FRAME,
	DISCORD_MODE_MAX_MODELS,
	DISCORD_MODE_MAX_PENDING,
	DISCORD_MODE_MAX_SESSIONS,
	DISCORD_MODE_MAX_PROGRESS_FILES,
	DISCORD_MODE_MAX_PROGRESS_LABEL,
	DISCORD_MODE_MAX_REPLY,
	DISCORD_MODE_MAX_SETTING_COMMANDS,
	DISCORD_MODE_MAX_SETTINGS_BYTES,
	DISCORD_MODE_MAX_SHORTLIST,
	DISCORD_MODE_MAX_TEXT,
	type BindingState,
	type ChannelInspection,
	type DiscordModeConfig,
	type DiscordPort,
	type DiscordPortHandlers,
	type ModeControlRequest,
	type ModeControlResult,
	type ModeDeletionEvent,
	type ModeDelivery,
	type ModeDialogAnswer,
	type ModeEnrollment,
	type ModeGroup,
	type ModeNoticeAction,
	type ModeOwnerMessage,
	type ModeApp,
	type ModeLease,
	type ModeRequest,
	type ModeNotify,
	type ModeServiceInfo,
	type ModeSession,
	type ModeProgress,
	type ModeSettingCommand,
	type ModeSettingsPanel,
	type ModeSettingsView,
	type ModeUsage,
	type ModeSnapshot,
	type RemoteChannel,
} from "@oh-my-pi/pi-wire/discord-mode";

export const DISCORD_MODE_LEASE_MS = 45_000;
export const DISCORD_MODE_RECONCILE_MS = 15_000;
export const DISCORD_MODE_MAX_JOURNAL_BYTES = 24 * 1024 * 1024;
export const DISCORD_MODE_MAX_OPERATIONS = 100_000;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_DELIVERIES = 2048;
const MAX_BACKLOG = 256;
const MAX_DIALOGS = 8;
const EFFECT_TIMEOUT_MS = 20_000;
/** A final reply to an owner turn at least this old pings in `needs-you` mode. */
export const DISCORD_MODE_LONG_TURN_MS = 120_000;
/** A dialog opening this soon after the session's previous one ended continues that exchange; no new ping. */
const DIALOG_MENTION_GRACE_MS = 5_000;
/** Instant, non-pinging reply to an owner message saved for a closed session. */
export const CLOSED_SAVED_TEXT =
	"This session is closed. Your message is saved and will be offered when you resume it.";
/** Missed-message catch-up bounds per bound channel. */
export const DISCORD_MODE_CATCH_UP_LIMIT = 50;
export const DISCORD_MODE_CATCH_UP_MS = 7 * 24 * 60 * 60 * 1000;
/** A service update switches only after nothing has been in flight for this long. */
export const DISCORD_MODE_SWITCH_QUIET_MS = 30_000;
/** Owner-facing refusal while the service stops to run an updated release. */
export const SERVICE_UPDATING_TEXT =
	"Haiso's Discord service is restarting for an update. This message will be offered again in a moment.";
const SESSION_CARD_FOOTER =
	"Normal messages wait for idle; queued messages can become guidance or be cancelled before dispatch. !steer sends guidance; !abort and Stop turn cancel the current turn, not the process.";
/** Graceful-stop card edits race the supervisor's stop grace. */
const STOP_CARDS_MS = 1_500;
const DISCORD_EPOCH = 1_420_070_400_000n;
/** Conversations running as background copies at once, whichever way they were started. */
export const DISCORD_MODE_MAX_BACKGROUND = 4;
/** A launch its copy has not claimed within this long is dropped, and a copy still starting is stopped. */
export const DISCORD_MODE_LAUNCH_TTL_MS = 10 * 60_000;
/** A launch whose copy is no longer running after this long without claiming it failed to start. */
export const DISCORD_MODE_LAUNCH_GRACE_MS = 15_000;
/** A background copy asked to leave that stays idle this long is stopped through its supervisor (graceful). */
export const DISCORD_MODE_STEP_ASIDE_STOP_MS = 60_000;
const MAX_LAUNCHES = 16;
/** `provider/model` for `--model`: never an option, never whitespace or shell syntax. */
const ModelSelector = type("string")
	.matching(/^[A-Za-z0-9._-]{1,64}\/[A-Za-z0-9._:@+/-]{1,160}$/)
	.narrow(value => !value.startsWith("-"));
/** Supervisor daemon name of a background copy: `haiso-s-<conversation>` or `haiso-n-<launch>`. */
const HostName = type("string").matching(/^haiso-[sn]-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const Notify = type("'all' | 'needs-you' | 'off'");
const App = type("'haiso' | 'omp'");
/** Card header and overview section tag per attaching app. */
const APP_TAGS: Record<ModeApp, string> = { haiso: "Haiso", omp: "OMP" };
const NOTIFY_DESCRIPTIONS: Record<ModeNotify, string> = {
	all: "You are mentioned for input requests and every final reply.",
	"needs-you": "You are mentioned for input requests and for final replies to turns that took 2 minutes or longer.",
	off: "You are never mentioned; messages still arrive silently.",
};
const Id = type("string").matching(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const RemoteId = type("string").matching(/^\d{1,22}$/);
const RequestId = type("string")
	.atLeastLength(1)
	.atMostLength(128)
	.matching(/^[A-Za-z0-9_.:-]+$/);
const SafePath = type("string")
	.atLeastLength(1)
	.atMostLength(4096)
	.narrow(value => path.isAbsolute(value) && !/[\x00-\x1f]/.test(value));
const Text = type("string")
	.atLeastLength(1)
	.atMostLength(DISCORD_MODE_MAX_TEXT)
	.matching(/^[^\x00-\x08\x0b\x0c\x0e-\x1f]*$/)
	.narrow(value => Buffer.byteLength(value) <= DISCORD_MODE_MAX_TEXT);
/** Final reply receipts only; everything else stays within Text. */
const ReplyText = type("string")
	.atLeastLength(1)
	.atMostLength(DISCORD_MODE_MAX_REPLY)
	.matching(/^[^\x00-\x08\x0b\x0c\x0e-\x1f]*$/)
	.narrow(value => Buffer.byteLength(value) <= DISCORD_MODE_MAX_REPLY);
const Label = type("string")
	.atLeastLength(1)
	.atMostLength(100)
	.matching(/^[^\x00-\x1f\x7f]*$/)
	.narrow(value => value.trim().length > 0);
const Token = type("string").matching(/^[a-f0-9]{64}$/);
const Timestamp = type("number").nonNegative().narrow(Number.isSafeInteger);
const OptionalText = type("string")
	.atMostLength(DISCORD_MODE_MAX_TEXT)
	.matching(/^[^\x00-\x08\x0b\x0c\x0e-\x1f]*$/)
	.narrow(value => Buffer.byteLength(value) <= DISCORD_MODE_MAX_TEXT);
const LeaseShape = type({ sessionId: Id, connectionId: Id, token: Token, "+": "reject" });
const DialogShape = type({
	id: RequestId,
	kind: "'select' | 'confirm' | 'input' | 'editor'",
	title: Text,
	"message?": Text,
	"options?": Text.array().atLeastLength(1).atMostLength(25),
	"prefill?": OptionalText,
	"+": "reject",
});
const Plain = (max: number) =>
	type("string")
		.atLeastLength(1)
		.atMostLength(max)
		.matching(/^[^\x00-\x1f\x7f]+$/);
const Selector = Plain(200);
const EffortName = type("string").matching(/^[a-z0-9-]{1,16}$/);
const SettingKind = type("'model' | 'effort' | 'default' | 'compact' | 'advisor' | 'advisor-model' | 'plan'");
const ModelChoiceShape = type({
	selector: Selector,
	name: Plain(100),
	"role?": Plain(32),
	efforts: EffortName.array().atMostLength(10),
	"+": "reject",
});
const SettingsViewShape = type({
	revision: type("string").matching(/^[A-Za-z0-9_-]{1,64}$/),
	"model?": ModelChoiceShape,
	"effort?": EffortName,
	"advisor?": { enabled: "boolean", active: "boolean", "model?": Selector, "+": "reject" },
	"plan?": { enabled: "boolean", "+": "reject" },
	capabilities: { persist: "boolean", compact: "boolean", advisor: "boolean", plan: "boolean", "+": "reject" },
	shortlist: ModelChoiceShape.array().atMostLength(DISCORD_MODE_MAX_SHORTLIST),
	models: ModelChoiceShape.array().atMostLength(DISCORD_MODE_MAX_MODELS),
	"+": "reject",
}).narrow(view => Buffer.byteLength(JSON.stringify(view)) <= DISCORD_MODE_MAX_SETTINGS_BYTES);
const Amount = type("number").narrow(value => Number.isFinite(value) && value >= 0);
const UsageShape = type({ tokens: Amount, contextWindow: Amount, percent: Amount, "+": "reject" });
/** Shape only: a clock step must never invalidate a whole poll, so elapsed time is clamped when rendered instead. */
const ProgressShape = type({
	startedAt: Timestamp,
	phase: "'thinking' | 'reading' | 'editing' | 'running' | 'searching' | 'delegating' | 'compacting' | 'retrying'",
	files: type("number").narrow(
		value => Number.isSafeInteger(value) && value >= 0 && value <= DISCORD_MODE_MAX_PROGRESS_FILES,
	),
	"last?": {
		label: Plain(DISCORD_MODE_MAX_PROGRESS_LABEL),
		outcome: "'pass' | 'fail' | 'timeout' | 'started'",
		"+": "reject",
	},
	"+": "reject",
});
const RequestShape = type.or(
	{
		op: "'register'",
		requestId: RequestId,
		sessionId: Id,
		sessionFile: SafePath,
		projectDir: SafePath,
		connectionId: Id,
		label: Label,
		groupName: Label,
		"app?": App,
		"rejoin?": "true",
		"launchId?": Id,
		"host?": "'background'",
		"+": "reject",
	},
	{ op: "'retire'", eventId: Id, "+": "reject" },
	{
		op: "'poll'",
		lease: LeaseShape,
		busy: "boolean",
		pendingInput: "boolean",
		"settings?": SettingsViewShape,
		"usage?": UsageShape,
		"progress?": ProgressShape,
		"+": "reject",
	},
	{
		op: "'command-result'",
		lease: LeaseShape,
		commandId: Id,
		outcome: "'applied' | 'rejected' | 'failed'",
		text: type("string")
			.atLeastLength(1)
			.atMostLength(500)
			.matching(/^[^\x00-\x08\x0b\x0c\x0e-\x1f]*$/),
		"settings?": SettingsViewShape,
		"usage?": UsageShape,
		"+": "reject",
	},
	{ op: "'status'", lease: LeaseShape, "+": "reject" },
	{ op: "'off'", lease: LeaseShape, "+": "reject" },
	{ op: "'detach'", lease: LeaseShape, "+": "reject" },
	{ op: "'disable'", sessionId: Id, sessionFile: SafePath, projectDir: SafePath, "+": "reject" },
	{ op: "'step-aside'", sessionId: Id, sessionFile: SafePath, projectDir: SafePath, "+": "reject" },
	{ op: "'background'", lease: LeaseShape, "+": "reject" },
	{
		op: "'receipt'",
		lease: LeaseShape,
		deliveryId: Id,
		state: "'accepted' | 'completed' | 'rejected'",
		"text?": ReplyText,
		"+": "reject",
	},
	{ op: "'resolve-delivery'", lease: LeaseShape, requestId: RequestId, deliveryId: Id, "+": "reject" },
	{ op: "'send'", lease: LeaseShape, requestId: RequestId, recipientId: Id, text: Text, "+": "reject" },
	{ op: "'report'", lease: LeaseShape, requestId: RequestId, text: Text, "+": "reject" },
	{ op: "'dialog'", lease: LeaseShape, dialog: DialogShape, "+": "reject" },
	{ op: "'dialog-end'", lease: LeaseShape, dialogId: RequestId, "+": "reject" },
	{
		op: "'rename'",
		lease: LeaseShape,
		requestId: RequestId,
		target: "'session' | 'group'",
		name: Label,
		"+": "reject",
	},
	{
		op: "'repair'",
		lease: LeaseShape,
		requestId: RequestId,
		target: "'session' | 'group'",
		"destinationId?": RemoteId,
		resumeQueued: type("boolean").default(false),
		"+": "reject",
	},
	{
		op: "'held'",
		lease: LeaseShape,
		requestId: RequestId,
		action: "'send' | 'discard'",
		"deliveryIds?": Id.array().atLeastLength(1).atMostLength(DISCORD_MODE_MAX_PENDING),
		"+": "reject",
	},
);
const Binding = type("'ready' | 'missing' | 'inaccessible' | 'moved' | 'offline' | 'unbound' | 'uncertain'");
// Journal shapes drop undeclared keys instead of rejecting them, so a rollback from a release that added optional
// fields still loads the journal; only declared fields are ever written back.
const GroupShape = type({
	id: Id,
	projectDir: SafePath,
	name: Label,
	"categoryId?": RemoteId,
	"overviewId?": RemoteId,
	state: Binding,
	uncertain: "boolean",
	overviewUncertain: "boolean",
	"+": "delete",
});
const RetirementShape = type({
	eventId: Id,
	policy: "'retain' | 'delete'",
	deletedAt: Timestamp,
	state: "'pending' | 'done' | 'attention'",
	"channelId?": RemoteId,
	"error?": type("string").atMostLength(500),
	"+": "delete",
});
const SessionShape = type({
	id: Id,
	groupId: Id,
	sessionFile: SafePath,
	projectDir: SafePath,
	label: Label,
	"channelId?": RemoteId,
	connectionId: Id,
	enabled: "boolean",
	connected: "boolean",
	busy: "boolean",
	pendingInput: "boolean",
	state: Binding,
	token: Token,
	seenAt: Timestamp,
	uncertain: "boolean",
	"retirement?": RetirementShape,
	"notify?": Notify,
	"app?": App,
	/** Daemon name of the background copy holding (or last holding) the lease; absent for terminal hosts. */
	"host?": HostName,
	"+": "delete",
});
const DeliveryShape = type({
	id: Id,
	sessionId: Id,
	from: type("string").atMostLength(128),
	source: "'owner' | 'peer'",
	kind: "'message' | 'steer' | 'abort'",
	text: OptionalText,
	state: "'queued' | 'dispatched' | 'accepted' | 'completed' | 'rejected' | 'unknown' | 'resolved'",
	createdAt: Timestamp,
	connectionId: Id,
	held: "boolean",
	"channelId?": RemoteId,
	"sourceMessageId?": RemoteId,
	"+": "delete",
});
const OperationShape = type({
	fingerprint: Token,
	state: "'working' | 'done' | 'unknown' | 'failed'",
	"error?": type("string").atMostLength(500),
	"+": "delete",
});
const AnswerShape = type({ id: RequestId, "value?": OptionalText.or("boolean"), cancelled: "boolean", "+": "delete" });
const PendingDialogShape = type({
	sessionId: Id,
	connectionId: Id,
	dialog: DialogShape.onUndeclaredKey("delete"),
	state: "'pending' | 'answered'",
	"answer?": AnswerShape,
	"+": "delete",
});
const CardShape = type({
	channelId: RemoteId,
	fingerprint: Token,
	state: "'working' | 'done' | 'unknown'",
	"messageId?": RemoteId,
	"+": "delete",
});
const OperationsShape = type({ "[string]": OperationShape }).narrow(operations =>
	Object.keys(operations).every(key => /^[a-f0-9]{64}$/.test(key)),
);
/** Last processed owner message per bound channel; missed messages are fetched after it on reconnect. */
const WatermarksShape = type({ "[string]": RemoteId }).narrow(
	marks =>
		Object.keys(marks).length <= DISCORD_MODE_MAX_SESSIONS * 2 &&
		Object.keys(marks).every(key => /^\d{1,22}$/.test(key)),
);
/**
 * A background copy the owner started from Discord (or a terminal chose to keep running), until the copy's single-use
 * registration claims it. `new` carries the conversation's name and first message; `channelId` hears about failures.
 */
const LaunchShape = type({
	id: Id,
	kind: "'resume' | 'new'",
	groupId: Id,
	"sessionId?": Id,
	"label?": Label,
	"message?": Text,
	"model?": ModelSelector,
	name: HostName,
	channelId: RemoteId,
	createdAt: Timestamp,
	"+": "delete",
});
const JournalShape = type({
	version: "1",
	guildId: RemoteId,
	ownerId: RemoteId,
	groups: GroupShape.array().atMostLength(DISCORD_MODE_MAX_SESSIONS),
	sessions: SessionShape.array().atMostLength(DISCORD_MODE_MAX_SESSIONS),
	deliveries: DeliveryShape.array().atMostLength(MAX_DELIVERIES),
	dialogs: PendingDialogShape.array().atMostLength(DISCORD_MODE_MAX_SESSIONS * MAX_DIALOGS),
	operations: OperationsShape,
	cards: CardShape.array().atMostLength(DISCORD_MODE_MAX_SESSIONS * 2),
	"watermarks?": WatermarksShape,
	"launches?": LaunchShape.array().atMostLength(MAX_LAUNCHES),
	/** Service liveness: last heartbeat, and when a graceful stop began (cleared once back online). */
	"service?": { "heartbeatAt?": Timestamp, "stoppedAt?": Timestamp, "+": "delete" },
	/**
	 * The maintained pinned guide, and what the last start announced: the guide hash plus its subcommands and sections
	 * (a later hash change posts one what's-new note naming additions), and that start's service version.
	 */
	"guide?": {
		"channelId?": RemoteId,
		"messageId?": RemoteId,
		"hash?": Token,
		"commands?": Plain(64).array().atMostLength(64),
		"sections?": Plain(100).array().atMostLength(64),
		"version?": Plain(64),
		"+": "delete",
	},
	"+": "delete",
});
const OwnerMessageShape = type({
	id: RemoteId,
	channelId: RemoteId,
	ownerId: RemoteId,
	text: OptionalText,
	kind: "'message' | 'steer' | 'abort'",
	"rejected?": type("string").atMostLength(1000),
	"+": "reject",
});
const ControlShape = type({
	id: RequestId,
	channelId: RemoteId,
	ownerId: RemoteId,
	action:
		"'status' | 'stop' | 'queue' | 'cancel' | 'steer' | 'notify' | 'settings' | 'setting' | 'discard' | 'release' | 'send-held' | 'discard-held' | 'review' | 'sessions' | 'resume' | 'new' | 'close'",
	"connectionId?": Id,
	"deliveryId?": Id,
	"notify?": Notify,
	"setting?": { kind: SettingKind, "value?": Selector.or("boolean"), "+": "reject" },
	"query?": Plain(100),
	"sessionId?": Id,
	"name?": Label,
	"message?": Text,
	"model?": ModelSelector,
	"+": "reject",
});
const RemoteAnswerShape = type({
	channelId: RemoteId,
	ownerId: RemoteId,
	dialogId: RequestId,
	"value?": OptionalText.or("boolean"),
	cancelled: "boolean",
	"+": "reject",
});
type Journal = typeof JournalShape.infer;
type Session = typeof SessionShape.infer;
type Group = typeof GroupShape.infer;
type Delivery = typeof DeliveryShape.infer;
type Operation = typeof OperationShape.infer;
type Launch = typeof LaunchShape.infer;
/** Only broker-authored, credential-free messages may cross the authenticated IPC error boundary. */
export class DiscordModeError extends Error {}
class UnknownEffect extends DiscordModeError {}

/** A session's last reported settings, bound to the connection that reported them. */
interface SettingsReport {
	connectionId: string;
	view?: ModeSettingsView;
	usage?: ModeUsage;
}
/** An owner settings change the current connection has not acknowledged; repeated on every poll until it does. */
interface PendingSetting {
	command: ModeSettingCommand;
	connectionId: string;
	channelId: string;
	dispatched: boolean;
}
/** Kinds whose newer undispatched choice replaces an older one instead of queueing behind it. */
const SUPERSEDABLE: Partial<Record<ModeSettingCommand["kind"], true>> = {
	model: true,
	effort: true,
	advisor: true,
	"advisor-model": true,
};
/** Recent settings interaction ids and settled command ids kept for idempotent replays. */
const SETTINGS_MEMORY = 256;
/** Progress-only card edits per session are at least this far apart. */
export const DISCORD_MODE_PROGRESS_CARD_MS = 10_000;
/** A session's live progress; `shown` is the line its card currently carries. */
interface ProgressReport {
	connectionId: string;
	progress: ModeProgress;
	shown?: string;
	renderedAt: number;
	/** Trailing edit for a change that arrived inside the spacing window. */
	timer?: NodeJS.Timeout;
}
/** One background copy to start: fixed arguments only, never names or message text. */
export interface DiscordHostSpec {
	/** Single-use launch id the copy presents when it registers. */
	launchId: string;
	/** Supervisor daemon name. */
	name: string;
	/** Canonical project folder from the journal; the copy's working directory. */
	projectDir: string;
	/** Resume: the journal's session file. Absent for a new conversation. */
	sessionFile?: string;
	/** New conversation only: a validated `provider/model` selector. */
	model?: string;
}
/** Starts and inspects background copies; the Discord service implements it over its process supervisor. */
export interface DiscordHostPort {
	start(spec: DiscordHostSpec): Promise<void>;
	/** Graceful stop (the copy tears down like a closed terminal). */
	stop(name: string): Promise<void>;
	/** Daemon names of background copies still starting or running. */
	running(): Promise<string[]>;
	/** Who holds a conversation's single-writer lock right now. */
	holder(sessionId: string): Promise<"terminal" | "background" | undefined>;
}
/** A background copy asked to leave at its next idle point; never journaled. */
interface StepAside {
	at: number;
	/** Since when the copy has reported idle while asked to leave. */
	idleSince?: number;
	stopped?: boolean;
}

/** Serialized durable routing for existing sessions; never owns or stops their engines. */
export class DiscordModeBroker {
	readonly #config: DiscordModeConfig;
	readonly #storePath: string;
	readonly #port: DiscordPort;
	/** Present in the Discord service: starts conversations in the background. */
	readonly #hosts: DiscordHostPort | undefined;
	#journal: Journal;
	#serial: Promise<void> = Promise.resolve();
	#backlog = 0;
	#operationCount = 0;
	#running = false;
	#failed = false;
	#gateway = false;
	#timer: NodeJS.Timeout | undefined;
	#reconcilePending = false;
	#cursor = 0;
	/** Last dialog end per session; volatile debounce for re-rendered asks, lost on restart by design. */
	#dialogEnded = new Map<string, number>();
	/** Last relabel attempted per channel; volatile so each wanted name is tried at most once per process. */
	#relabelled = new Map<string, string>();
	/** Settings are live session state, never journaled: a restart or reconnect makes the session report afresh. */
	#settings = new Map<string, SettingsReport>();
	#commands = new Map<string, PendingSetting[]>();
	#settled = new Set<string>();
	#settingControls = new Map<string, ModeControlResult>();
	/** Outcomes owed for changes dropped by revocation; posted once the current mutation finishes. */
	#settingNotes: Array<{ channelId: string; commandId: string; text: string }> = [];
	/** Set while stopping gracefully; overview cards then read `Offline since`. */
	#stoppedAt: number | undefined;
	#catchingUp = false;
	/** Live run progress per session, never journaled; drives one line on the session card only. */
	#progress = new Map<string, ProgressReport>();
	/** Background copies asked to leave (owner close or terminal takeover), by session id. */
	#stepAside = new Map<string, StepAside>();
	/** The running build; reported in snapshots so clients can tell an update is pending. */
	readonly #service: ModeServiceInfo | undefined;
	/** The pinned guide this build maintains; placed once per process, on the first connected gateway. */
	readonly #guide: DiscordGuide | undefined;
	#guidePlaced = false;
	#guidePending = false;
	/** Last time a session was busy, waiting for input, or given work; a service update needs a quiet spell. */
	#activeAt = 0;
	/** Stopped to run an updated release: the overview says so, and refusals say it is coming back. */
	#updating = false;

	constructor(options: {
		config: DiscordModeConfig;
		storePath: string;
		port: DiscordPort;
		hosts?: DiscordHostPort;
		service?: ModeServiceInfo;
		guide?: DiscordGuide;
	}) {
		RemoteId.assert(options.config.guildId);
		RemoteId.assert(options.config.ownerId);
		this.#config = options.config;
		this.#storePath = options.storePath;
		this.#port = options.port;
		this.#hosts = options.hosts;
		this.#service = options.service;
		this.#guide = options.guide;
		this.#journal = {
			version: 1,
			guildId: options.config.guildId,
			ownerId: options.config.ownerId,
			groups: [],
			sessions: [],
			deliveries: [],
			dialogs: [],
			operations: {},
			cards: [],
		};
	}

	async start(): Promise<void> {
		if (this.#running) return;
		await ensurePrivateDirectory(path.dirname(this.#storePath));
		const saved = await readPrivateJson(this.#storePath, DISCORD_MODE_MAX_JOURNAL_BYTES);
		if (saved !== undefined) this.#journal = JournalShape.assert(saved);
		if (this.#journal.guildId !== this.#config.guildId || this.#journal.ownerId !== this.#config.ownerId)
			throw new DiscordModeError(
				"Discord state belongs to another guild/owner; use a separate profile instead of rebinding retained history.",
			);
		this.#checkJournal();
		this.#operationCount = Object.keys(this.#journal.operations).length;
		if (this.#operationCount > DISCORD_MODE_MAX_OPERATIONS)
			throw new DiscordModeError(
				"Discord operation journal exceeds capacity; archive the private profile explicitly.",
			);
		for (const session of this.#journal.sessions) this.#revoke(session);
		for (const operation of Object.values(this.#journal.operations))
			if (operation.state === "working") operation.state = "unknown";
		for (const card of this.#journal.cards) if (card.state === "working") card.state = "unknown";
		this.#journal.dialogs = [];
		// Offline window: a graceful stop records when it began; a crash leaves only the last heartbeat.
		const crashedAt = this.#journal.service?.stoppedAt === undefined ? this.#journal.service?.heartbeatAt : undefined;
		this.#journal.service = { heartbeatAt: Date.now() };
		await this.#persist();
		this.#running = true;
		try {
			await this.#mutate(() => this.#consumeRetirements());
			await this.#port.start({
				ownerMessage: input => this.#mutate(() => this.#ownerMessage(input)),
				control: input => this.#mutate(() => this.#control(input)),
				answer: input => this.#mutate(() => this.#answer(input)),
				changed: () => this.#scheduleReconcile(),
				connection: connected => {
					this.#gateway = connected;
					if (!connected) return;
					void this.#scheduleReconcile();
					// Ready and resume both land here: fetch what the owner sent while the gateway was away.
					this.#scheduleCatchUp();
					void this.#scheduleGuide();
				},
			});
			await this.#mutate(() => this.#reconcile(true));
			if (crashedAt !== undefined) await this.#mutate(() => this.#announceOffline(crashedAt));
			await this.#scheduleGuide();
			this.#timer = setInterval(() => {
				void this.#scheduleReconcile();
			}, DISCORD_MODE_RECONCILE_MS);
			this.#timer.unref();
		} catch (error) {
			this.#running = false;
			await this.#port.close();
			throw error;
		}
	}

	async close(): Promise<void> {
		clearInterval(this.#timer);
		this.#timer = undefined;
		this.#running = false;
		await this.#serial;
		for (const entry of this.#progress.values()) clearTimeout(entry.timer);
		this.#progress.clear();
		if (!this.#failed) {
			for (const session of this.#journal.sessions) this.#revoke(session);
			const stoppedAt = Date.now();
			this.#journal.service = { ...this.#journal.service, stoppedAt };
			if (this.#gateway) await this.#offlineCards(stoppedAt);
			else await this.#persist();
		}
		this.#gateway = false;
		await this.#port.close();
	}

	async lookup(projectDir: string, sessionId: string): Promise<ModeEnrollment | undefined> {
		SafePath.assert(projectDir);
		Id.assert(sessionId);
		const canonical = await canonicalProjectDir(projectDir);
		return this.#mutate(async () => {
			// A crashed or detached process must read as disconnected before a rejoin decision.
			await this.#expire();
			await this.#consumeRetirements();
			const group = this.#journal.groups.find(item => item.projectDir === canonical);
			if (!group) return undefined;
			const session = this.#journal.sessions.find(item => item.id === sessionId && item.groupId === group.id);
			return { group: publicGroup(group), ...(session ? { session: publicSession(session) } : {}) };
		});
	}

	request(input: ModeRequest): Promise<ModeSnapshot> {
		let parsed: ModeRequest;
		try {
			if (Buffer.byteLength(JSON.stringify(input)) > DISCORD_MODE_MAX_FRAME)
				throw new DiscordModeError("Discord request exceeds frame limit.");
			parsed = RequestShape.assert(input);
		} catch {
			return Promise.reject(
				new DiscordModeError(
					"Invalid Discord request: check operation, UUIDs, absolute paths, text/byte limits, and allowed fields.",
				),
			);
		}
		// Heartbeats are ephemeral liveness, not queued effects. An authenticated poll arriving
		// during a slow Discord mutation must not expire behind that same mutation.
		if (parsed.op === "poll") {
			const live = this.#journal.sessions.find(item => item.id === parsed.lease.sessionId);
			if (
				live?.enabled &&
				live.connected &&
				live.connectionId === parsed.lease.connectionId &&
				equalTokens(live.token, parsed.lease.token) &&
				Date.now() - live.seenAt < DISCORD_MODE_LEASE_MS
			)
				live.seenAt = Date.now();
		}
		return this.#mutate(async () => {
			await this.#expire();
			await this.#consumeRetirements(parsed.op === "retire" ? parsed.eventId : undefined);
			if (parsed.op === "retire") {
				const retired = this.#journal.sessions.find(item => item.retirement?.eventId === parsed.eventId);
				if (!retired)
					throw new DiscordModeError("Deletion intent is not committed or does not match an enrolled session.");
				await this.#reconcileRetirement(retired);
				await this.#reconcileGroup(this.#group(retired.groupId));
				await this.#cards(this.#group(retired.groupId));
				return this.#snapshot(retired);
			}
			if (parsed.op === "register") return this.#register(parsed);
			if (parsed.op === "disable") return this.#disable(parsed);
			if (parsed.op === "step-aside") return this.#stepAsideRequest(parsed);
			const session = this.#authorize(parsed.lease);
			switch (parsed.op) {
				case "poll":
					return this.#poll(session, parsed);
				case "background":
					return this.#background(session);
				case "command-result":
					await this.#commandResult(session, parsed);
					break;
				case "status":
					await this.#reconcileSession(session);
					await this.#persist();
					await this.#cards(this.#group(session.groupId));
					return {
						...this.#snapshot(session),
						deliveries: this.#journal.deliveries
							.filter(item => item.sessionId === session.id)
							.map(publicDelivery),
					};
				case "off":
					this.#revoke(session);
					session.enabled = false;
					await this.#persist();
					await this.#cards(this.#group(session.groupId));
					break;
				case "detach":
					// Closing a conversation keeps it shared: resuming it rejoins the same channel.
					this.#revoke(session);
					await this.#persist();
					await this.#cards(this.#group(session.groupId));
					break;
				case "receipt":
					await this.#receipt(session, parsed);
					break;
				case "resolve-delivery": {
					let resolved: ModeDelivery | undefined;
					await this.#perform(`request:${session.id}:${parsed.requestId}`, parsed, async () => {
						const delivery = this.#journal.deliveries.find(
							item => item.id === parsed.deliveryId && item.sessionId === session.id,
						);
						if (!delivery || delivery.state !== "unknown")
							throw new DiscordModeError(
								"Only an unknown delivery in this session can be explicitly resolved. Resolution does not claim execution, publish success, or replay work.",
							);
						delivery.state = "resolved";
						resolved = publicDelivery(delivery);
						this.#journal.deliveries = this.#journal.deliveries.filter(item => item.id !== delivery.id);
					});
					await this.#cards(this.#group(session.groupId));
					return { ...this.#snapshot(session), deliveries: resolved ? [resolved] : [] };
				}
				case "send": {
					const recipient = this.#session(parsed.recipientId);
					if (recipient.id === session.id || recipient.groupId !== session.groupId)
						throw new DiscordModeError(
							"Peer messages require another enrolled session in the exact same project directory.",
						);
					this.#requireLive(recipient);
					await this.#perform(`request:${session.id}:${parsed.requestId}`, parsed, async () => {
						this.#enqueue(recipient, session.id, "peer", "message", parsed.text);
					});
					await this.#cards(this.#group(recipient.groupId));
					break;
				}
				case "report": {
					await this.#reconcileSession(session);
					this.#requireRemote(session);
					await this.#perform(`request:${session.id}:${parsed.requestId}`, parsed, async () => {
						await this.#external(
							() =>
								this.#port.publish(session.channelId!, parsed.text, `report:${session.id}:${parsed.requestId}`),
							session,
						);
					});
					break;
				}
				case "dialog":
					await this.#dialog(session, parsed);
					break;
				case "dialog-end":
					await this.#endDialog(session, parsed.dialogId);
					break;
				case "rename":
					await this.#rename(session, parsed);
					break;
				case "repair":
					await this.#repair(session, parsed);
					break;
				case "held":
					await this.#perform(`request:${session.id}:${parsed.requestId}`, parsed, async () => {
						this.#settleSaved(session, parsed.action, parsed.deliveryIds);
					});
					await this.#cards(this.#group(session.groupId));
					return {
						...this.#snapshot(session),
						deliveries: this.#journal.deliveries
							.filter(item => item.sessionId === session.id)
							.map(publicDelivery),
					};
			}
			return this.#snapshot(session);
		});
	}

	#mutate<T>(run: () => Promise<T>): Promise<T> {
		if (!this.#running || this.#failed)
			return Promise.reject(
				new DiscordModeError(
					this.#updating
						? SERVICE_UPDATING_TEXT
						: "Discord broker is offline or private persistence failed; reconnect after repair.",
				),
			);
		if (this.#backlog >= MAX_BACKLOG)
			return Promise.reject(
				new DiscordModeError("Discord broker backlog is full; wait for pending requests before retrying."),
			);
		this.#backlog++;
		const result = this.#serial
			.then(() => {
				if (!this.#running || this.#failed)
					throw new DiscordModeError(
						this.#updating ? SERVICE_UPDATING_TEXT : "Discord broker stopped; no request was executed.",
					);
				return run();
			})
			.finally(() => {
				this.#backlog--;
				// Revocation drops changes synchronously; tell the owner outside the serialized queue, never pinging.
				for (const note of this.#settingNotes.splice(0))
					void this.#port.settingsResult(note.channelId, note.commandId, note.text).catch(() => {});
			});
		this.#serial = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async #persist(): Promise<void> {
		try {
			if (Buffer.byteLength(JSON.stringify(this.#journal)) > DISCORD_MODE_MAX_JOURNAL_BYTES)
				throw new DiscordModeError(
					"Discord private journal is full. Stop mode and explicitly archive its profile; retained request fences must not be discarded while sessions are active.",
				);
			await writePrivateJson(this.#storePath, this.#journal);
		} catch (error) {
			this.#failed = true;
			throw error;
		}
	}

	#operation(key: string, input: unknown): { operation: Operation; exists: boolean } {
		const id = digest(key);
		const fingerprint = digest(input);
		const existing = this.#journal.operations[id];
		if (existing) {
			if (existing.fingerprint !== fingerprint)
				throw new DiscordModeError("Request identifier was already used with different input.");
			if (existing.state !== "done")
				throw new DiscordModeError(
					existing.error ??
						"Prior effect is uncertain. Inspect Discord and use explicit repair with a selected destination; never replay the request.",
				);
			return { operation: existing, exists: true };
		}
		if (this.#operationCount >= DISCORD_MODE_MAX_OPERATIONS)
			throw new DiscordModeError(
				"Discord dedup journal is full (100,000 retained intents). Stop mode and explicitly archive this private profile before starting a new one; old requests must not be replayed.",
			);
		const operation: Operation = { fingerprint, state: "working" };
		this.#journal.operations[id] = operation;
		this.#operationCount++;
		return { operation, exists: false };
	}

	async #perform(key: string, input: unknown, run: () => Promise<void>): Promise<void> {
		const { operation, exists } = this.#operation(key, input);
		if (exists) return;
		await this.#persist();
		try {
			await run();
			operation.state = "done";
			await this.#persist();
		} catch (error) {
			operation.state = error instanceof UnknownEffect ? "unknown" : "failed";
			operation.error =
				error instanceof DiscordModeError
					? error.message.slice(0, 500)
					: "Discord operation failed; inspect the binding before retrying.";
			if (!this.#failed) await this.#persist();
			throw error;
		}
	}

	async #external<T>(run: () => Promise<T>, binding?: Session | Group): Promise<T> {
		let timer: NodeJS.Timeout | undefined;
		try {
			if (!this.#gateway) throw new DiscordModeError("Discord gateway is offline");
			const deadline = Promise.withResolvers<never>();
			timer = setTimeout(
				() => deadline.reject(new DiscordModeError("Discord effect deadline elapsed")),
				EFFECT_TIMEOUT_MS,
			);
			return await Promise.race([run(), deadline.promise]);
		} catch {
			if (binding) {
				binding.uncertain = true;
				binding.state = "uncertain";
				this.#hold(binding);
			}
			throw new UnknownEffect(
				"Discord effect outcome is unknown. Inspect the resource; use explicit repair/adoption, not a repeated effect.",
			);
		} finally {
			clearTimeout(timer);
		}
	}

	async #register(input: Extract<ModeRequest, { op: "register" }>): Promise<ModeSnapshot> {
		try {
			sessionChannelName(input.label);
			discordCategoryName(input.groupName);
		} catch {
			throw new DiscordModeError(
				"Choose a nonempty Discord project/session name containing usable letters, numbers, underscores, or hyphens.",
			);
		}
		const projectDir = await canonicalProjectDir(input.projectDir);
		const sessionFile = path.join(
			await canonicalProjectDir(path.dirname(input.sessionFile)),
			path.basename(input.sessionFile),
		);
		let session = this.#journal.sessions.find(item => item.id === input.sessionId);
		if (session?.retirement)
			throw new DiscordModeError(
				"This conversation was permanently deleted; its identity cannot be enrolled again.",
			);
		// Rejoin never enrolls: explicit off (here or in another window) and unknown identities stay unshared.
		if (input.rejoin && !session?.enabled)
			throw new DiscordModeError("Sharing is off or unknown for this conversation; automatic rejoin skipped.");
		const registration = { ...input, projectDir, sessionFile };
		const prior = this.#journal.operations[digest(`register:${input.sessionId}:${input.requestId}`)];
		if (prior) {
			this.#operation(`register:${input.sessionId}:${input.requestId}`, registration);
			if (!session || !session.enabled || !session.connected || session.connectionId !== input.connectionId)
				throw new DiscordModeError(
					"Registration belongs to a revoked connection; reconnect with fresh connection and request identifiers.",
				);
			session.seenAt = Date.now();
			return this.#snapshot(session, true);
		}
		if (session && (session.projectDir !== projectDir || session.sessionFile !== sessionFile))
			throw new DiscordModeError(
				"Persistent session UUID cannot be rebound to a different project directory or session file.",
			);
		if (session?.connected)
			throw new DiscordModeError(
				"Session already has a live lease; wait for expiry or turn mode off in the original session.",
			);
		if (
			session?.connectionId === input.connectionId ||
			this.#journal.operations[digest(`connection:${input.sessionId}:${input.connectionId}`)]
		)
			throw new DiscordModeError("A revoked connection generation cannot be reused.");
		if (this.#journal.sessions.some(item => item.id !== input.sessionId && item.sessionFile === sessionFile))
			throw new DiscordModeError("Session file already belongs to another persistent session UUID.");
		if (!session && this.#journal.sessions.length >= DISCORD_MODE_MAX_SESSIONS)
			throw new DiscordModeError(
				"Discord session capacity reached (128 retained identities); explicitly archive an inactive profile rather than evicting identity/replay fences.",
			);
		if (this.#operationCount + 2 > DISCORD_MODE_MAX_OPERATIONS)
			throw new DiscordModeError(
				"Discord dedup journal is full; explicitly archive the inactive private profile before enrolling more sessions.",
			);
		let peerBytes = Buffer.byteLength(JSON.stringify({ ...input, projectDir, sessionFile })) + 2048;
		for (const peer of this.#journal.sessions)
			if (peer.projectDir === projectDir && peer.id !== input.sessionId && !peer.retirement)
				peerBytes += Buffer.byteLength(JSON.stringify(publicSession(peer))) + 256;
		if (peerBytes > DISCORD_MODE_MAX_FRAME / 2)
			throw new DiscordModeError(
				"Project membership metadata exceeds its bounded IPC budget; use shorter absolute session paths or another explicit project directory.",
			);
		// A launch is single-use: a resume claims its own conversation, a new conversation its project's group and name.
		const launch =
			input.launchId === undefined
				? undefined
				: this.#claimLaunch(input.launchId, input.sessionId, session, projectDir);
		const label = launch?.kind === "new" ? launch.label! : input.label;
		let group = this.#journal.groups.find(item => item.projectDir === projectDir);
		if (group && !session) this.#requireCategoryCapacity(group);
		const newGroup = !group;
		if (!group) {
			group = {
				id: randomUUID(),
				projectDir,
				name: input.groupName,
				state: "unbound",
				uncertain: false,
				overviewUncertain: false,
			};
			this.#journal.groups.push(group);
		}
		const newSession = !session;
		if (!session) {
			session = {
				id: input.sessionId,
				groupId: group.id,
				sessionFile,
				projectDir,
				label: sessionLabel(label) ?? label,
				connectionId: input.connectionId,
				enabled: true,
				connected: true,
				busy: false,
				pendingInput: false,
				state: "unbound",
				token: randomBytes(32).toString("hex"),
				seenAt: Date.now(),
				uncertain: false,
				...(input.app === "omp" ? { app: input.app } : {}),
			};
			this.#journal.sessions.push(session);
		} else {
			this.#revoke(session);
			session.connectionId = input.connectionId;
			session.token = randomBytes(32).toString("hex");
			session.enabled = true;
			session.connected = true;
			session.seenAt = Date.now();
			// The last attaching app owns the session; a flip is visible as a channel marker rename and card tag.
			if (input.app === "omp") session.app = input.app;
			else delete session.app;
		}
		// Only a background copy names its supervisor daemon; a terminal registration clears the marker.
		if (input.host === "background") session.host = launch?.name ?? session.host ?? `haiso-s-${session.id}`;
		else delete session.host;
		const registered = session;
		const selectedGroup = group;
		await this.#perform(`register:${input.sessionId}:${input.requestId}`, registration, async () => {
			const connection = this.#operation(`connection:${input.sessionId}:${input.connectionId}`, {
				sessionId: input.sessionId,
				connectionId: input.connectionId,
			});
			connection.operation.state = "done";
			// Resource intent is durable before the first API call. A failed creation is never repeated.
			try {
				if (newGroup) await this.#createGroup(selectedGroup);
				else await this.#reconcileGroup(selectedGroup);
				if (newSession && selectedGroup.state === "ready") await this.#createSession(registered, selectedGroup);
				else await this.#relabel(registered, await this.#reconcileSession(registered, false));
			} catch (error) {
				if (!(error instanceof UnknownEffect)) throw error;
			}
			await this.#arrange(selectedGroup);
		});
		await this.#cards(selectedGroup);
		// Saved messages are offered on resume, never dispatched: the owner decides here or at the desk.
		const saved = newSession ? 0 : this.#saved(registered).length;
		if (saved)
			await this.#notice(
				registered,
				`${saved} message${saved === 1 ? "" : "s"} arrived while this session was closed.`,
				`arrivals:${registered.id}:${registered.connectionId}`,
				[
					{ action: "review", label: "Review" },
					{ action: "send-held", label: "Send all" },
					{ action: "discard-held", label: "Discard" },
				],
			);
		if (launch?.kind === "new") await this.#firstMessage(registered, launch);
		registered.seenAt = Date.now();
		return this.#snapshot(registered, true);
	}

	async #createGroup(group: Group): Promise<void> {
		group.state = "uncertain";
		group.uncertain = true;
		await this.#persist();
		const category = await this.#external(() => this.#port.createCategory(group.name), group);
		this.#validateRemote(category, "category");
		this.#assertUnbound(category.id, group.id);
		group.categoryId = category.id;
		group.name = category.name;
		group.overviewUncertain = true;
		await this.#persist();
		const overview = await this.#external(
			() => this.#port.createChannel(category.id, "overview", `haiso:group:${group.id}`),
			group,
		);
		this.#validateRemote(overview, "text", category.id);
		this.#assertUnbound(overview.id);
		group.overviewId = overview.id;
		group.overviewUncertain = false;
		group.uncertain = false;
		group.state = "ready";
		await this.#persist();
	}

	#requireCategoryCapacity(group: Group, replacingSessionId?: string): void {
		const retained = this.#journal.sessions.filter(
			session =>
				session.groupId === group.id &&
				session.id !== replacingSessionId &&
				session.channelId !== undefined &&
				!(session.retirement?.policy === "delete" && session.retirement.state === "done"),
		).length;
		if (retained >= 49)
			throw new DiscordModeError(
				"This project already retains 49 session channels plus its overview, reaching Discord's 50-channel category limit. No resource was created. Use another explicit project/profile or reconcile existing bindings; categories are never split automatically.",
			);
	}

	async #createSession(session: Session, group: Group): Promise<void> {
		if (!group.categoryId || group.state !== "ready")
			throw new DiscordModeError("Repair the project category before creating a session channel.");
		this.#requireCategoryCapacity(group, session.id);
		const baseName = sessionSlug(session.label);
		const occupied = new Set<string>(["overview"]);
		for (const peer of this.#journal.sessions)
			if (peer.groupId === group.id && peer.id !== session.id && peer.channelId) {
				try {
					occupied.add(sessionSlug(peer.label));
				} catch {
					/* A manual name with no usable slug cannot collide with a generated slug. */
				}
			}
		// Slugs stay unique per project across apps; the marker is presentation only.
		let slug = baseName;
		for (let suffix = 0; occupied.has(slug); suffix++) {
			const discriminator = `${session.id.slice(0, 8)}${suffix ? `-${suffix}` : ""}`;
			slug = `${baseName.slice(0, 96 - discriminator.length)}-${discriminator}`;
		}
		const channelName = sessionChannelName(slug, session.app);
		session.state = "uncertain";
		session.uncertain = true;
		await this.#persist();
		const channel = await this.#external(
			() => this.#port.createChannel(group.categoryId!, channelName, `haiso:session:${session.id}`),
			session,
		);
		this.#validateRemote(channel, "text", group.categoryId);
		this.#assertUnbound(channel.id);
		session.channelId = channel.id;
		session.label = sessionLabel(channel.name) ?? session.label;
		session.uncertain = false;
		session.state = "ready";
		// A fresh channel has no history to catch up on; anything later is missed-message work.
		this.#advanceWatermark(channel.id, snowflakeAt(Date.now()));
		await this.#persist();
	}

	#authorize(lease: ModeLease): Session {
		const session = this.#session(lease.sessionId);
		if (session.retirement)
			throw new DiscordModeError("This conversation was permanently deleted; its lease is revoked.");
		if (
			!session.enabled ||
			!session.connected ||
			session.connectionId !== lease.connectionId ||
			!equalTokens(session.token, lease.token)
		)
			throw new DiscordModeError("Session lease is invalid, expired, or revoked; reconnect explicitly.");
		return session;
	}

	#requireLive(session: Session): void {
		if (session.retirement)
			throw new DiscordModeError("This conversation was permanently deleted; delivery is disabled.");
		if (!session.enabled) throw new DiscordModeError("Session is off; delivery is disabled.");
		if (!session.connected || Date.now() - session.seenAt >= DISCORD_MODE_LEASE_MS)
			throw new DiscordModeError(
				"This conversation isn't open locally; resume it to reconnect. Delivery is disabled until then.",
			);
	}

	/** Holds a working lease: enabled, connected, and heard from within the lease window. */
	#live(session: Session): boolean {
		return session.enabled && session.connected && Date.now() - session.seenAt < DISCORD_MODE_LEASE_MS;
	}

	/** Saved owner messages of one session, in arrival order; `ids` narrows to those. */
	#saved(session: Session, ids?: readonly string[]): Delivery[] {
		return this.#journal.deliveries.filter(
			item =>
				item.sessionId === session.id &&
				item.source === "owner" &&
				item.from === this.#config.ownerId &&
				item.kind === "message" &&
				item.state === "queued" &&
				item.held &&
				(ids === undefined || ids.includes(item.id)),
		);
	}

	/** Release saved messages to the current connection (dispatched in arrival order), or drop them. */
	#settleSaved(session: Session, action: "send" | "discard", ids?: readonly string[]): number {
		const saved = this.#saved(session, ids);
		if (action === "discard") {
			const dropped = new Set(saved.map(item => item.id));
			this.#journal.deliveries = this.#journal.deliveries.filter(item => !dropped.has(item.id));
			return saved.length;
		}
		this.#requireLive(session);
		for (const delivery of saved) {
			delivery.connectionId = session.connectionId;
			delivery.channelId = session.channelId;
			delivery.held = false;
		}
		return saved.length;
	}

	/** Keeps the newest processed owner message per channel; unbound channels are pruned when a new one appears. */
	#advanceWatermark(channelId: string, messageId: string): void {
		const marks = (this.#journal.watermarks ??= {});
		const current = marks[channelId];
		if (current === undefined)
			for (const key of Object.keys(marks))
				if (!this.#journal.sessions.some(session => session.channelId === key)) delete marks[key];
		if (current === undefined || BigInt(messageId) > BigInt(current)) marks[channelId] = messageId;
	}

	#requireRemote(session: Session, requireLive = true): void {
		if (requireLive) this.#requireLive(session);
		if (
			!this.#gateway ||
			session.state !== "ready" ||
			this.#group(session.groupId).state !== "ready" ||
			!session.channelId
		)
			throw new DiscordModeError(
				"Remote session binding is paused. Inspect /discord status and use explicit /discord repair; history is preserved.",
			);
	}

	#revoke(session: Session): void {
		session.connected = false;
		session.token = randomBytes(32).toString("hex");
		for (const delivery of this.#journal.deliveries)
			if (delivery.sessionId === session.id) {
				if (delivery.state === "queued") delivery.held = true;
				else if (delivery.state === "dispatched" || delivery.state === "accepted") delivery.state = "unknown";
			}
		this.#journal.dialogs = this.#journal.dialogs.filter(item => item.sessionId !== session.id);
		// Settings changes are connection-bound: none survives into a later connection or process.
		const view = this.#settings.get(session.id)?.view;
		this.#settings.delete(session.id);
		for (const item of this.#commands.get(session.id) ?? [])
			this.#settingNotes.push({
				channelId: item.channelId,
				commandId: item.command.id,
				text: item.dispatched
					? `Outcome unknown (${describeSettingCommand(item.command, view)}): the session disconnected before confirming. Check /session settings once it's back.`
					: `Not applied (${describeSettingCommand(item.command, view)}): the session disconnected first.`,
			});
		this.#commands.delete(session.id);
		clearTimeout(this.#progress.get(session.id)?.timer);
		this.#progress.delete(session.id);
		this.#stepAside.delete(session.id);
	}

	async #expire(): Promise<void> {
		let changed = false;
		for (const session of this.#journal.sessions)
			if (session.connected && Date.now() - session.seenAt >= DISCORD_MODE_LEASE_MS) {
				this.#revoke(session);
				changed = true;
			}
		if (changed) await this.#persist();
	}

	/** Sticky off by native identity, without a lease: a later rejoin is refused until an explicit enable. */
	async #disable(input: Extract<ModeRequest, { op: "disable" }>): Promise<ModeSnapshot> {
		const session = this.#journal.sessions.find(item => item.id === input.sessionId);
		if (!session) throw new DiscordModeError("This conversation is not shared with Discord.");
		const sessionFile = path.join(
			await canonicalProjectDir(path.dirname(input.sessionFile)),
			path.basename(input.sessionFile),
		);
		if (session.projectDir !== (await canonicalProjectDir(input.projectDir)) || session.sessionFile !== sessionFile)
			throw new DiscordModeError(
				"Persistent session UUID is bound to a different project directory or session file.",
			);
		if (session.retirement)
			throw new DiscordModeError("This conversation was permanently deleted; Discord mode is already off.");
		// #expire already ran, so a connected session has a live lease elsewhere.
		if (session.connected)
			throw new DiscordModeError(
				"This conversation still holds a live Discord connection (another window, or a lease not yet expired); turn it off there or retry shortly.",
			);
		if (session.enabled) {
			this.#revoke(session);
			session.enabled = false;
			await this.#persist();
			await this.#cards(this.#group(session.groupId));
		}
		return this.#snapshot(session);
	}

	#enqueue(
		session: Session,
		from: string,
		source: "owner" | "peer",
		kind: ModeDelivery["kind"],
		text: string,
		sourceMessageId?: string,
		/** Save for a closed session: skips the live-lease check, never the budgets. */
		held = false,
	): void {
		if (!held) this.#requireLive(session);
		else if (session.retirement || !session.enabled)
			throw new DiscordModeError("This conversation is not shared anymore; nothing was saved.");
		let sessionBytes = Buffer.byteLength(text);
		for (const delivery of this.#journal.deliveries)
			if (delivery.sessionId === session.id) {
				sessionBytes += Buffer.byteLength(JSON.stringify(publicDelivery(delivery)));
				if (kind === "message" && delivery.state === "unknown")
					throw new DiscordModeError(
						"A previous delivery has an unknown execution outcome. Inspect its original text in status and reconcile explicitly before ordinary work resumes.",
					);
			}
		if (sessionBytes > 96 * 1024)
			throw new DiscordModeError(
				"Session pending payload budget is full (96 KiB); resolve pending/uncertain work before sending more.",
			);
		if (
			this.#journal.deliveries.length >= MAX_DELIVERIES ||
			this.#journal.deliveries.filter(item => item.sessionId === session.id).length >= DISCORD_MODE_MAX_PENDING
		)
			throw new DiscordModeError(
				"Session delivery queue is full (32 per session, 2048 total). Complete pending work or explicitly resume held queued work; uncertain work will not be replayed.",
			);
		this.#checkPayload(Buffer.byteLength(text));
		this.#journal.deliveries.push({
			id: randomUUID(),
			sessionId: session.id,
			connectionId: session.connectionId,
			channelId: source === "owner" ? session.channelId : undefined,
			sourceMessageId,
			from,
			source,
			kind,
			text,
			state: "queued",
			createdAt: Date.now(),
			held,
		});
	}

	async #poll(session: Session, input: Extract<ModeRequest, { op: "poll" }>): Promise<ModeSnapshot> {
		const { busy, pendingInput } = input;
		if (
			this.#journal.deliveries.some(
				item => item.sessionId === session.id && item.source === "owner" && item.state === "queued",
			) ||
			this.#journal.dialogs.some(item => item.sessionId === session.id && item.answer)
		)
			await this.#reconcileSession(session);
		const changed = session.busy !== busy || session.pendingInput !== pendingInput;
		session.seenAt = Date.now();
		session.busy = busy;
		session.pendingInput = pendingInput;
		// A copy asked to leave gets no new owner turns; how long it has been idle decides a supervisor stop.
		const leaving = this.#stepAside.get(session.id);
		if (leaving) leaving.idleSince = busy || pendingInput ? undefined : (leaving.idleSince ?? Date.now());
		if (input.settings || input.usage) this.#report(session, input.settings, input.usage);
		// A progress-only change edits just this session's card, throttled; state flips re-render everything below.
		const progressDue = this.#reportProgress(session, busy ? input.progress : undefined, changed);
		// Unacknowledged changes repeat on every poll; the session dedups by id and re-sends a lost result.
		const commands: ModeSettingCommand[] = [];
		for (const item of this.#commands.get(session.id) ?? [])
			if (item.connectionId === session.connectionId) {
				item.dispatched = true;
				commands.push({ ...item.command });
			}
		let responseBytes =
			Buffer.byteLength(JSON.stringify(this.#snapshot(session))) +
			Buffer.byteLength(JSON.stringify(commands)) +
			1024;
		const deliveries: ModeDelivery[] = [];
		const active = this.#journal.deliveries.some(
			item =>
				item.sessionId === session.id &&
				(item.state === "unknown" ||
					(item.kind === "message" && (item.state === "dispatched" || item.state === "accepted"))),
		);
		let dispatchedMessage = active;
		for (const delivery of this.#journal.deliveries) {
			if (
				delivery.sessionId !== session.id ||
				delivery.connectionId !== session.connectionId ||
				delivery.state !== "queued" ||
				delivery.held
			)
				continue;
			if (
				delivery.source === "owner" &&
				(!this.#gateway || session.state !== "ready" || this.#group(session.groupId).state !== "ready")
			)
				continue;
			if (delivery.kind === "message" && (busy || pendingInput || dispatchedMessage || leaving)) continue;
			const bytes = Buffer.byteLength(JSON.stringify(publicDelivery(delivery))) + 1;
			if (responseBytes + bytes > DISCORD_MODE_MAX_FRAME - 2048) break;
			responseBytes += bytes;
			delivery.state = "dispatched";
			if (delivery.kind === "message") dispatchedMessage = true;
			deliveries.push(publicDelivery(delivery));
			// Bounded response even when controls bypass a busy engine.
			if (deliveries.length === 4) break;
		}
		const answers: ModeDialogAnswer[] = [];
		for (const dialog of this.#journal.dialogs)
			if (
				dialog.sessionId === session.id &&
				dialog.connectionId === session.connectionId &&
				dialog.answer &&
				this.#gateway &&
				session.state === "ready" &&
				this.#group(session.groupId).state === "ready"
			) {
				const bytes = Buffer.byteLength(JSON.stringify(dialog.answer)) + 1;
				if (responseBytes + bytes > DISCORD_MODE_MAX_FRAME - 2048) break;
				responseBytes += bytes;
				answers.push({ ...dialog.answer });
				delete dialog.answer;
			}
		if (busy || pendingInput || deliveries.length || answers.length || commands.length) this.#activeAt = Date.now();
		if (changed || deliveries.length || answers.length) await this.#persist();
		if (changed || deliveries.length) await this.#cards(this.#group(session.groupId));
		else if (progressDue) await this.#sessionCard(session);
		return { ...this.#snapshot(session), deliveries, answers, ...(commands.length ? { commands } : {}) };
	}

	/** Stores this poll's progress; true when the card must re-render now for its progress line alone. */
	#reportProgress(session: Session, progress: ModeProgress | undefined, immediate: boolean): boolean {
		let entry = this.#progress.get(session.id);
		if (!progress) {
			if (!entry) return false;
			clearTimeout(entry.timer);
			this.#progress.delete(session.id);
			return entry.shown !== undefined;
		}
		if (entry?.connectionId !== session.connectionId) {
			clearTimeout(entry?.timer);
			entry = { connectionId: session.connectionId, progress, renderedAt: 0 };
			this.#progress.set(session.id, entry);
		}
		entry.progress = progress;
		return this.#progressDue(session.id, entry, immediate);
	}

	/**
	 * Adopts the current line when it changed and the spacing window allows; otherwise arms one trailing edit. Only a
	 * changed line ever edits, and progress alone edits a card at most once per DISCORD_MODE_PROGRESS_CARD_MS.
	 */
	#progressDue(sessionId: string, entry: ProgressReport, immediate: boolean): boolean {
		const line = formatDiscordProgressLine(entry.progress, Date.now());
		if (line === entry.shown) return false;
		const wait = entry.renderedAt + DISCORD_MODE_PROGRESS_CARD_MS - Date.now();
		if (!immediate && wait > 0) {
			entry.timer ??= setTimeout(() => {
				entry.timer = undefined;
				void this.#mutate(async () => {
					const session = this.#journal.sessions.find(item => item.id === sessionId);
					if (session && this.#progress.get(sessionId) === entry && this.#progressDue(sessionId, entry, true))
						await this.#sessionCard(session);
				}).catch(() => {});
			}, wait).unref();
			return false;
		}
		clearTimeout(entry.timer);
		entry.timer = undefined;
		entry.shown = line;
		entry.renderedAt = Date.now();
		return true;
	}

	#report(session: Session, view: ModeSettingsView | undefined, usage: ModeUsage | undefined): void {
		const report = this.#settingsFor(session) ?? { connectionId: session.connectionId };
		if (view) report.view = view;
		if (usage) report.usage = usage;
		this.#settings.set(session.id, report);
	}

	#settingsFor(session: Session): SettingsReport | undefined {
		const report = this.#settings.get(session.id);
		return report?.connectionId === session.connectionId ? report : undefined;
	}

	#panel(session: Session, view: ModeSettingsView, usage: ModeUsage | undefined): ModeSettingsPanel {
		return {
			view,
			...(usage ? { usage } : {}),
			busy: session.busy || session.pendingInput,
			pending: (this.#commands.get(session.id) ?? []).map(item => ({ ...item.command })),
		};
	}

	#settingsPanel(session: Session, query: string | undefined): ModeControlResult {
		const connectionId = this.#controlConnection(session);
		if (!connectionId) return { text: "This conversation isn't open locally; resume it to change its settings." };
		const report = this.#settingsFor(session);
		if (!report?.view)
			return {
				text: "This session hasn't reported its settings. Its app may predate Discord settings, or it just connected; try again in a moment.",
			};
		const settings = this.#panel(session, report.view, report.usage);
		if (query === undefined) return { text: "", connectionId, settings };
		settings.matches = rankSettingsModels(report.view.models, query, DISCORD_MODE_MAX_SHORTLIST);
		return {
			text: settings.matches.length
				? `${settings.matches.length} model${settings.matches.length === 1 ? "" : "s"} match “${query}”.`
				: `No model matches “${query}”.`,
			connectionId,
			settings,
		};
	}

	/** Validate one owner change against what the session reported, then queue it for the session's next idle moment. */
	#queueSetting(session: Session, input: ModeControlRequest): ModeControlResult {
		const repeated = this.#settingControls.get(input.id);
		if (repeated) return repeated;
		this.#requireLive(session);
		const connectionId = this.#controlConnection(session);
		const report = this.#settingsFor(session);
		if (!connectionId || !report?.view)
			throw new DiscordModeError("This session isn't reporting its settings right now; reopen the settings panel.");
		const view = report.view;
		const setting = input.setting!;
		const queue = this.#commands.get(session.id) ?? [];
		const value = this.#settingValue(session, view, queue, setting);
		const duplicate = queue.find(item => item.command.kind === setting.kind && item.command.value === value);
		let result: ModeControlResult;
		if (duplicate) {
			result = {
				text: `Already pending: ${describeSettingCommand(duplicate.command, view)}. You'll get one confirmation when it applies.`,
				connectionId,
				settings: this.#panel(session, view, report.usage),
			};
		} else {
			// The session never saw an undispatched change, so a newer choice of the same kind simply replaces it.
			const replaced = SUPERSEDABLE[setting.kind]
				? queue.findIndex(item => !item.dispatched && item.command.kind === setting.kind)
				: -1;
			if (replaced >= 0) {
				const [old] = queue.splice(replaced, 1);
				this.#settingNotes.push({
					channelId: old!.channelId,
					commandId: old!.command.id,
					text: `Not applied (${describeSettingCommand(old!.command, view)}): replaced by your newer choice.`,
				});
			}
			if (queue.length >= DISCORD_MODE_MAX_SETTING_COMMANDS)
				throw new DiscordModeError("Too many settings changes are pending; wait for them to apply.");
			const command: ModeSettingCommand = {
				id: randomUUID(),
				kind: setting.kind,
				...(value === undefined ? {} : { value }),
			};
			queue.push({ command, connectionId, channelId: session.channelId!, dispatched: false });
			this.#commands.set(session.id, queue);
			const described = describeSettingCommand(command, view);
			result = {
				text:
					session.busy || session.pendingInput
						? `Pending — applies after this turn: ${described}.`
						: `Sent to the session: ${described}. You'll get a confirmation once it applies.`,
				connectionId,
				commandId: command.id,
				settings: this.#panel(session, view, report.usage),
			};
		}
		this.#settingControls.set(input.id, result);
		if (this.#settingControls.size > SETTINGS_MEMORY)
			this.#settingControls.delete(this.#settingControls.keys().next().value!);
		return result;
	}

	/** The command value the session will receive; refuses anything the session did not offer. */
	#settingValue(
		session: Session,
		view: ModeSettingsView,
		queue: PendingSetting[],
		setting: NonNullable<ModeControlRequest["setting"]>,
	): string | boolean | undefined {
		const unsupported = () => new DiscordModeError("This session doesn't offer that setting.");
		switch (setting.kind) {
			case "model":
			case "advisor-model": {
				if (setting.kind === "advisor-model" && !view.capabilities.advisor) throw unsupported();
				const choice = typeof setting.value === "string" ? findSettingsChoice(view, setting.value) : undefined;
				if (!choice)
					throw new DiscordModeError(
						"That model is no longer offered by this session; reopen the settings panel.",
					);
				return choice.selector;
			}
			case "effort": {
				// Efforts follow the model the session will run: a pending model change, else the current one.
				const pendingModel = queue.findLast(item => item.command.kind === "model")?.command.value;
				const model = typeof pendingModel === "string" ? findSettingsModel(view, pendingModel) : view.model;
				if (typeof setting.value !== "string" || !model?.efforts.includes(setting.value))
					throw new DiscordModeError(
						`${model?.name ?? "The session's model"} doesn't support effort ${String(setting.value)}.`,
					);
				return setting.value;
			}
			case "default":
				if (!view.capabilities.persist) throw unsupported();
				return undefined;
			case "compact":
				if (!view.capabilities.compact) throw unsupported();
				if (session.busy || session.pendingInput)
					throw new DiscordModeError("The session is busy; compact it once it's idle.");
				return undefined;
			case "advisor":
				if (!view.capabilities.advisor) throw unsupported();
				if (typeof setting.value !== "boolean") throw new DiscordModeError("Choose advisor on or off.");
				return setting.value;
			case "plan":
				if (!view.capabilities.plan) throw unsupported();
				if (view.plan?.enabled)
					throw new DiscordModeError("Plan mode is already on; leaving it goes through plan approval.");
				return undefined;
		}
	}

	/** The session applied (or refused) one change; confirm it to the owner with the fresh view. */
	async #commandResult(session: Session, input: Extract<ModeRequest, { op: "command-result" }>): Promise<void> {
		if (this.#settled.has(input.commandId)) return;
		const queue = this.#commands.get(session.id) ?? [];
		const index = queue.findIndex(
			item => item.command.id === input.commandId && item.connectionId === session.connectionId && item.dispatched,
		);
		if (index < 0)
			throw new DiscordModeError("Settings result does not match a change dispatched to this connection.");
		const [item] = queue.splice(index, 1);
		if (!queue.length) this.#commands.delete(session.id);
		this.#settled.add(input.commandId);
		if (this.#settled.size > SETTINGS_MEMORY) this.#settled.delete(this.#settled.values().next().value!);
		if (input.settings || input.usage) this.#report(session, input.settings, input.usage);
		const report = this.#settingsFor(session);
		if (!this.#gateway) return;
		// Best effort and never an uncertain binding: the panel and /session settings show the state either way.
		const deadline = Promise.withResolvers<void>();
		const timer = setTimeout(deadline.resolve, EFFECT_TIMEOUT_MS);
		try {
			await Promise.race([
				this.#port
					.settingsResult(
						item!.channelId,
						input.commandId,
						input.text,
						report?.view ? this.#panel(session, report.view, report.usage) : undefined,
					)
					.catch(() => {}),
				deadline.promise,
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	async #receipt(session: Session, input: Extract<ModeRequest, { op: "receipt" }>): Promise<void> {
		const key = `receipt:${input.deliveryId}:${input.state}`;
		const existing = this.#journal.operations[digest(key)];
		if (existing) {
			this.#operation(key, input);
			return;
		}
		const delivery = this.#journal.deliveries.find(item => item.id === input.deliveryId);
		if (!delivery || delivery.sessionId !== session.id || delivery.connectionId !== session.connectionId)
			throw new DiscordModeError("Receipt does not belong to this session connection and exact delivery.");
		if (delivery.state !== "dispatched" && delivery.state !== "accepted")
			throw new DiscordModeError(
				"Receipt requires a dispatched delivery in the current generation; queued/unknown work cannot be completed or replayed.",
			);
		if (input.state === "accepted" && input.text !== undefined)
			throw new DiscordModeError(
				"Accepted receipts cannot publish results; send a completed/rejected receipt after execution.",
			);
		if (input.text !== undefined) {
			await this.#reconcileSession(session);
			this.#requireRemote(session);
			if (delivery.source === "owner" && delivery.channelId !== session.channelId)
				throw new DiscordModeError(
					"Delivery belonged to an earlier channel binding; its result cannot be posted into the replacement channel.",
				);
		}
		await this.#perform(key, input, async () => {
			delivery.state = input.state;
			try {
				if (input.text !== undefined)
					await this.#external(
						() =>
							this.#port.reply(session.channelId!, input.text!, key, {
								mention: this.#replyMention(session, delivery, input.state),
							}),
						session,
					);
				if (input.state !== "accepted")
					this.#journal.deliveries = this.#journal.deliveries.filter(item => item.id !== delivery.id);
			} catch (error) {
				delivery.state = "unknown";
				throw error;
			}
		});
		await this.#cards(this.#group(session.groupId));
	}

	async #ownerMessage(raw: Parameters<DiscordPortHandlers["ownerMessage"]>[0]): Promise<ModeControlResult> {
		await this.#expire();
		if (raw.ownerId !== this.#config.ownerId) return { text: "" };
		await this.#consumeRetirements();
		const session = this.#journal.sessions.find(item => item.channelId === raw.channelId);
		if (!session) return { text: "" };
		if (session.retirement) return { text: "This conversation was permanently deleted; nothing was forwarded." };
		let input: typeof OwnerMessageShape.infer;
		try {
			input = OwnerMessageShape.assert(raw);
			if (!input.rejected && input.kind !== "abort") Text.assert(input.text);
		} catch {
			throw new DiscordModeError("Invalid owner message: check identifiers, text limits, and allowed fields.");
		}
		this.#advanceWatermark(input.channelId, input.id);
		await this.#reconcileSession(session);
		await this.#expire();
		await this.#persist();
		// A closed conversation (still shared, no live lease) saves plain messages for its next resume.
		const closed = session.enabled && !this.#live(session);
		this.#requireRemote(session, !closed);
		if (input.rejected) return { text: input.rejected };
		if (closed && input.kind !== "message")
			return {
				text: `This session is closed; ${input.kind === "abort" ? "!abort" : "!steer"} needs it open at your desk. Nothing was saved.`,
			};
		await this.#perform(`owner:${input.id}`, input, async () => {
			this.#enqueue(session, input.ownerId, "owner", input.kind, input.text, input.id, closed);
		});
		await this.#cards(this.#group(session.groupId));
		const delivery = this.#journal.deliveries.find(
			item => item.sessionId === session.id && item.source === "owner" && item.sourceMessageId === input.id,
		);
		if (!delivery)
			return { text: "Previously received; no actionable queued copy was identified. Nothing was replayed." };
		if (delivery.state !== "queued")
			return { text: `Previously received; delivery is ${delivery.state}. Nothing was replayed.` };
		if (this.#actionable(session, delivery))
			return {
				text: "Queued for the next idle turn. You can send it as guidance or cancel it before dispatch.",
				deliveryId: delivery.id,
				connectionId: session.connectionId,
			};
		if (delivery.held && delivery.kind === "message" && !this.#live(session))
			return { text: CLOSED_SAVED_TEXT, deliveryId: delivery.id, connectionId: session.connectionId, saved: true };
		return {
			text: delivery.held
				? "Retained in the held queue; explicit repair and resumption are required before dispatch."
				: delivery.kind === "message"
					? "The message remains queued but is not currently actionable; check session status."
					: `Queued ${delivery.kind} control; dispatch has not been confirmed.`,
		};
	}

	#controlConnection(session: Session): string | undefined {
		return this.#gateway &&
			session.enabled &&
			session.connected &&
			Date.now() - session.seenAt < DISCORD_MODE_LEASE_MS &&
			session.state === "ready" &&
			this.#group(session.groupId).state === "ready"
			? session.connectionId
			: undefined;
	}

	#actionable(session: Session, delivery: Delivery): boolean {
		return (
			this.#controlConnection(session) !== undefined &&
			delivery.sessionId === session.id &&
			delivery.source === "owner" &&
			delivery.from === this.#config.ownerId &&
			delivery.kind === "message" &&
			delivery.state === "queued" &&
			!delivery.held &&
			delivery.connectionId === session.connectionId &&
			delivery.channelId === session.channelId
		);
	}

	async #control(raw: ModeControlRequest): Promise<ModeControlResult> {
		let input: ModeControlRequest;
		try {
			input = ControlShape.assert(raw);
			if (
				((input.action === "cancel" || input.action === "steer") && (!input.connectionId || !input.deliveryId)) ||
				((input.action === "discard" || input.action === "release") && !input.deliveryId) ||
				(input.deliveryId !== undefined &&
					input.action !== "queue" &&
					input.action !== "cancel" &&
					input.action !== "steer" &&
					input.action !== "discard" &&
					input.action !== "release" &&
					input.action !== "review") ||
				(input.action === "notify") !== (input.notify !== undefined) ||
				(input.action === "setting") !== (input.setting !== undefined) ||
				(input.action === "setting" && !input.connectionId) ||
				(input.query !== undefined && input.action !== "settings") ||
				(input.action === "new" && (input.name === undefined || input.message === undefined)) ||
				(input.action !== "new" &&
					(input.name !== undefined || input.message !== undefined || input.model !== undefined)) ||
				(input.sessionId !== undefined && input.action !== "resume")
			)
				throw new Error("Invalid control fields");
		} catch {
			throw new DiscordModeError("Invalid session control: check identifiers, action, and allowed fields.");
		}
		if (input.ownerId !== this.#config.ownerId)
			throw new DiscordModeError("Only the configured owner can use session controls.");
		await this.#expire();
		await this.#consumeRetirements();
		// Project-wide actions work in a project's overview and in any of its session channels.
		if (input.action === "sessions" || input.action === "resume" || input.action === "new")
			return this.#launchControl(input);
		const session = this.#journal.sessions.find(item => item.channelId === input.channelId);
		if (!session) throw new DiscordModeError("This channel is not bound to a session.");
		if (session.retirement) {
			if (input.action === "status") return { text: this.#sessionStatus(session) };
			if (input.action === "queue")
				return {
					text: "This conversation was permanently deleted. No messages are queued; nothing can be forwarded.",
					queued: [],
				};
			throw new DiscordModeError("This conversation was permanently deleted; old controls are disabled.");
		}
		await this.#reconcileSession(session);
		await this.#expire();
		await this.#persist();
		this.#requireRemote(session, false);
		if (input.action === "close") return this.#closeControl(session);
		// Saved-message buttons outlive the connection that was current when they were posted.
		if (
			input.action === "discard" ||
			input.action === "release" ||
			input.action === "send-held" ||
			input.action === "discard-held" ||
			input.action === "review"
		)
			return this.#savedControl(session, input);
		if (
			input.connectionId !== undefined &&
			(input.connectionId !== session.connectionId || !session.enabled || !session.connected)
		)
			throw new DiscordModeError("Session control belongs to a stale connection; use the current session controls.");
		if (input.action === "notify") {
			session.notify = input.notify!;
			await this.#persist();
			await this.#cards(this.#group(session.groupId));
			return { text: `Notifications: ${input.notify}. ${NOTIFY_DESCRIPTIONS[input.notify!]}` };
		}
		if (input.action === "settings") return this.#settingsPanel(session, input.query);
		if (input.action === "setting") return this.#queueSetting(session, input);
		const readOnly = input.action === "status" || input.action === "queue";
		if (readOnly) await this.#cards(this.#group(session.groupId));
		if (input.action === "status")
			return { text: this.#sessionStatus(session), connectionId: this.#controlConnection(session) };
		if (input.action === "queue") {
			const queued = this.#journal.deliveries
				.filter(
					item =>
						item.sessionId === session.id &&
						item.source === "owner" &&
						item.from === this.#config.ownerId &&
						item.kind === "message" &&
						item.state === "queued" &&
						(input.deliveryId === undefined || item.id === input.deliveryId),
				)
				.map(item => ({
					id: item.id,
					text: item.text,
					createdAt: item.createdAt,
					held: item.held,
					actionable: this.#actionable(session, item),
				}));
			if (input.deliveryId !== undefined && !queued.length)
				throw new DiscordModeError("That owner message is no longer queued in this session.");
			return {
				text:
					input.deliveryId !== undefined
						? `${queued[0]!.held ? "Held owner message (read-only)" : "Queued owner message"}\n${queued[0]!.text}`
						: queued.length
							? `${queued.length} owner message${queued.length === 1 ? "" : "s"} queued. Held messages require explicit repair and resumption.`
							: "No owner messages are queued.",
				connectionId: this.#controlConnection(session),
				deliveryId: input.deliveryId,
				queued,
			};
		}
		this.#requireLive(session);
		let changed = false;
		await this.#perform(`control:${input.id}`, input, async () => {
			this.#requireLive(session);
			if (input.action === "stop") {
				this.#enqueue(session, input.ownerId, "owner", "abort", "");
			} else {
				const delivery = this.#journal.deliveries.find(item => item.id === input.deliveryId);
				if (!delivery || !this.#actionable(session, delivery))
					throw new DiscordModeError(
						"Only a queued, non-held owner message in this channel's current connection can be cancelled or sent as guidance. Dispatched work cannot be changed.",
					);
				if (input.action === "cancel")
					this.#journal.deliveries = this.#journal.deliveries.filter(item => item.id !== delivery.id);
				else delivery.kind = "steer";
			}
			changed = true;
		});
		await this.#cards(this.#group(session.groupId));
		if (!changed) return { text: "This control was already processed. No new change was made." };
		return {
			text:
				input.action === "cancel"
					? "Cancelled the queued message before dispatch."
					: input.action === "steer"
						? "Queued the existing message as guidance for the current connection; dispatch is not yet confirmed."
						: "Queued Stop turn. This requests cancellation of the current turn, not the process.",
		};
	}

	/** Review, send, or discard saved owner messages. Sending needs the session open; the rest works while closed. */
	async #savedControl(session: Session, input: ModeControlRequest): Promise<ModeControlResult> {
		const ids = input.deliveryId === undefined ? undefined : [input.deliveryId];
		const gone = "That saved message was already sent or discarded.";
		if (input.action === "review") {
			const saved = this.#saved(session, ids);
			if (ids && !saved.length) throw new DiscordModeError(gone);
			return {
				text: ids
					? `Saved message\n${saved[0]!.text}`
					: saved.length
						? `${saved.length} saved message${saved.length === 1 ? "" : "s"}. Pick one to send or discard it.`
						: "No saved messages are waiting.",
				connectionId: session.connectionId,
				...(ids ? { deliveryId: input.deliveryId } : {}),
				queued: saved.map(item => ({
					id: item.id,
					text: item.text,
					createdAt: item.createdAt,
					held: true,
					actionable: false,
				})),
				review: true,
			};
		}
		const send = input.action === "release" || input.action === "send-held";
		if (send && !this.#live(session))
			return { text: "This session is closed. Saved messages will be offered when you resume it at your desk." };
		let count = 0;
		await this.#perform(`control:${input.id}`, input, async () => {
			count = this.#settleSaved(session, send ? "send" : "discard", ids);
		});
		await this.#cards(this.#group(session.groupId));
		if (!count) return { text: ids ? gone : "No saved messages are waiting." };
		const noun = `${count} saved message${count === 1 ? "" : "s"}`;
		return {
			text: send ? `Sending ${noun} in order as the session becomes idle.` : `Discarded ${noun}.`,
		};
	}

	/**
	 * `sessions`, `resume`, `new`: owner-only (checked by the caller), inside one project the journal knows; nothing
	 * here reaches a folder, file, or argument that did not come from the journal or a strict pattern.
	 */
	async #launchControl(input: ModeControlRequest): Promise<ModeControlResult> {
		if (!this.#hosts)
			throw new DiscordModeError(
				"This Discord service can't start conversations in the background. Update Haiso, then restart the service.",
			);
		const group = await this.#controlGroup(input.channelId);
		if (input.action === "sessions") {
			const resumable = this.#journal.sessions
				.filter(session => session.groupId === group.id && this.#resumable(session))
				.sort((left, right) => right.seenAt - left.seenAt)
				.slice(0, DISCORD_MODE_MAX_SHORTLIST)
				.map(session => ({ id: session.id, label: session.label }));
			return {
				text: resumable.length
					? `${resumable.length} closed conversation${resumable.length === 1 ? "" : "s"} in ${group.name} can be resumed. Pick one to start it in the background.`
					: `No closed conversation in ${group.name} can be resumed from Discord right now.`,
				resumable,
			};
		}
		let result: ModeControlResult = { text: "This request was already handled; nothing new was started." };
		await this.#perform(`control:${input.id}`, input, async () => {
			result = input.action === "new" ? await this.#launchNew(group, input) : await this.#launchResume(group, input);
		});
		await this.#cards(group);
		return result;
	}

	/** The project a channel belongs to: its overview, a bound session channel, or another channel in its category. */
	async #controlGroup(channelId: string): Promise<Group> {
		const bound = this.#journal.sessions.find(session => session.channelId === channelId);
		let group = this.#journal.groups.find(item => item.overviewId === channelId || item.id === bound?.groupId);
		if (!group) {
			const inspected = await this.#inspect(channelId);
			const parentId = inspected.state === "found" ? inspected.channel.parentId : undefined;
			if (parentId) group = this.#journal.groups.find(item => item.categoryId === parentId);
		}
		if (!group)
			throw new DiscordModeError("Use this in a Haiso project's #overview or in one of its session channels.");
		await this.#reconcileGroup(group);
		if (!this.#gateway || group.state !== "ready")
			throw new DiscordModeError(
				"This project's Discord category needs repair first (/discord repair at your desk); nothing was started.",
			);
		return group;
	}

	/** A closed, still shared Haiso conversation with a usable channel: the only kind Discord may resume. */
	#resumable(session: Session): boolean {
		return (
			session.enabled &&
			!session.retirement &&
			!this.#live(session) &&
			(session.app ?? "haiso") === "haiso" &&
			session.state === "ready" &&
			session.channelId !== undefined &&
			!this.#journal.launches?.some(launch => launch.sessionId === session.id)
		);
	}

	async #launchResume(group: Group, input: ModeControlRequest): Promise<ModeControlResult> {
		const session = this.#journal.sessions.find(item =>
			input.sessionId === undefined ? item.channelId === input.channelId : item.id === input.sessionId,
		);
		if (!session || session.groupId !== group.id)
			throw new DiscordModeError("That conversation isn't part of this project; nothing was started.");
		if (session.retirement)
			throw new DiscordModeError("This conversation was permanently deleted; it can't be resumed.");
		await this.#reconcileSession(session, false);
		if (this.#live(session))
			return {
				text: session.host
					? "It's already running in the background."
					: "It's open at your desk right now; nothing was started.",
			};
		if (this.#journal.launches?.some(launch => launch.sessionId === session.id))
			return { text: "It's already starting in the background." };
		if ((session.app ?? "haiso") !== "haiso")
			throw new DiscordModeError("This is an OMP session; resume it in OMP at your desk.");
		if (!session.enabled)
			throw new DiscordModeError("Sharing is off for this conversation; turn it on at your desk first.");
		if (!this.#resumable(session))
			throw new DiscordModeError(
				"This conversation's channel needs repair first (/discord repair at your desk); nothing was started.",
			);
		const holder = await this.#hosts!.holder(session.id);
		if (holder)
			return {
				text:
					holder === "terminal"
						? "It's open in a terminal right now; close it there first."
						: "It's already running in the background.",
			};
		const [file, folder] = await Promise.all([
			fs.stat(session.sessionFile).catch(() => undefined),
			fs.stat(session.projectDir).catch(() => undefined),
		]);
		if (!file?.isFile() || !folder?.isDirectory())
			throw new DiscordModeError(
				"Its conversation file or project folder is missing on this computer; nothing was started.",
			);
		await this.#launch(
			{
				kind: "resume",
				groupId: group.id,
				sessionId: session.id,
				name: `haiso-s-${session.id}`,
				channelId: session.channelId!,
			},
			{ projectDir: session.projectDir, sessionFile: session.sessionFile },
		);
		return {
			text: `Starting ${session.label} in the background. It reconnects in <#${session.channelId}> shortly; messages saved while it was closed are offered there.`,
		};
	}

	async #launchNew(group: Group, input: ModeControlRequest): Promise<ModeControlResult> {
		const name = input.name!.trim();
		try {
			sessionChannelName(name);
		} catch {
			throw new DiscordModeError(
				"Choose a name with letters, numbers, underscores, or hyphens; nothing was started.",
			);
		}
		if (input.model !== undefined && !this.#knownModels().has(input.model))
			throw new DiscordModeError(
				`Model ${input.model} isn't one a running session offers. Leave it empty for the default model; nothing was started.`,
			);
		this.#requireCategoryCapacity(group);
		if (!(await fs.stat(group.projectDir).catch(() => undefined))?.isDirectory())
			throw new DiscordModeError("This project's folder is missing on this computer; nothing was started.");
		const id = randomUUID();
		await this.#launch(
			{
				kind: "new",
				groupId: group.id,
				label: name,
				message: input.message!,
				...(input.model === undefined ? {} : { model: input.model }),
				name: `haiso-n-${id}`,
				channelId: input.channelId,
			},
			{ projectDir: group.projectDir },
			id,
		);
		return {
			text: `Starting ${name} in the background. Its channel appears in this project shortly, and your first message runs there.`,
		};
	}

	/** Models a connected session reported: the only `--model` values a new conversation may start with. */
	#knownModels(): Set<string> {
		const known = new Set<string>();
		for (const report of this.#settings.values())
			for (const model of [...(report.view?.models ?? []), ...(report.view?.shortlist ?? [])])
				known.add(model.selector);
		return known;
	}

	/** Journal the launch, then start its copy; a copy that can't be started drops the launch again. */
	async #launch(
		fields: Omit<Launch, "id" | "createdAt">,
		target: { projectDir: string; sessionFile?: string },
		id: string = randomUUID(),
	): Promise<void> {
		const hosts = this.#hosts!;
		let running: string[];
		try {
			running = await hosts.running();
		} catch {
			throw new DiscordModeError("The process supervisor is unavailable; nothing was started.");
		}
		if (running.includes(fields.name)) throw new DiscordModeError("It's already starting in the background.");
		if (running.length >= DISCORD_MODE_MAX_BACKGROUND)
			throw new DiscordModeError(
				`${DISCORD_MODE_MAX_BACKGROUND} conversations are already running in the background. Close one with /session close first; nothing was started.`,
			);
		const launches = this.#journal.launches ?? [];
		if (launches.length >= MAX_LAUNCHES)
			throw new DiscordModeError("Too many conversations are starting at once; try again in a minute.");
		const launch: Launch = { ...fields, id, createdAt: Date.now() };
		this.#journal.launches = [...launches, launch];
		await this.#persist();
		try {
			await hosts.start({
				launchId: launch.id,
				name: launch.name,
				projectDir: target.projectDir,
				...(target.sessionFile === undefined ? {} : { sessionFile: target.sessionFile }),
				...(launch.model === undefined ? {} : { model: launch.model }),
			});
		} catch {
			this.#journal.launches = this.#journal.launches?.filter(item => item.id !== launch.id);
			await this.#persist();
			throw new DiscordModeError("The process supervisor couldn't start the background copy; nothing was started.");
		}
	}

	/** Takes the launch a registration claims (single use); a mismatched or expired one attaches nothing. */
	#claimLaunch(launchId: string, sessionId: string, session: Session | undefined, projectDir: string): Launch {
		const launches = this.#journal.launches ?? [];
		const launch = launches.find(item => item.id === launchId);
		const group = this.#journal.groups.find(item => item.id === launch?.groupId);
		if (
			!launch ||
			!group ||
			Date.now() - launch.createdAt >= DISCORD_MODE_LAUNCH_TTL_MS ||
			(launch.kind === "resume"
				? launch.sessionId !== sessionId || session?.groupId !== group.id
				: session !== undefined || group.projectDir !== projectDir)
		)
			throw new DiscordModeError(
				"This background launch is unknown, expired, or for another conversation; nothing was attached.",
			);
		this.#journal.launches = launches.filter(item => item !== launch);
		return launch;
	}

	/** A new conversation's first owner message, queued like any other once its copy is attached. */
	async #firstMessage(session: Session, launch: Launch): Promise<void> {
		const group = this.#group(session.groupId);
		let queued = true;
		try {
			await this.#perform(`launch:${launch.id}`, { launchId: launch.id, sessionId: session.id }, async () => {
				this.#enqueue(session, this.#config.ownerId, "owner", "message", launch.message!);
			});
		} catch {
			queued = false;
		}
		await this.#cards(group);
		const overviewId = group.overviewId;
		if (!overviewId || !this.#gateway) return;
		const where = session.channelId ? `<#${session.channelId}>` : session.label;
		try {
			await this.#external(() =>
				this.#port.publish(
					overviewId,
					queued
						? `Started ${where} in the background; your first message runs there.`
						: `Started ${where} in the background, but its first message couldn't be queued; send it again there.`,
					`launch:${launch.id}`,
				),
			);
		} catch {
			/* The new channel and its card show the conversation either way. */
		}
	}

	/** Close a background copy at its next idle point; history and sharing stay. Terminals close at the desk. */
	#closeControl(session: Session): ModeControlResult {
		if (!this.#live(session))
			return {
				text: "This session is already closed. History and sharing are kept; Resume starts it again.",
			};
		if (!session.host) return { text: "This session is open in a terminal; close it there." };
		if (!this.#stepAside.has(session.id)) this.#stepAside.set(session.id, { at: Date.now() });
		return {
			text:
				session.busy || session.pendingInput
					? "It will close after this turn. History and sharing are kept."
					: "Closing it now. History and sharing are kept.",
		};
	}

	/** A terminal takes over from a background copy: by native identity like `disable`, never with a lease. */
	async #stepAsideRequest(input: Extract<ModeRequest, { op: "step-aside" }>): Promise<ModeSnapshot> {
		const session = this.#journal.sessions.find(item => item.id === input.sessionId);
		if (!session) throw new DiscordModeError("This conversation is not shared with Discord.");
		const sessionFile = path.join(
			await canonicalProjectDir(path.dirname(input.sessionFile)),
			path.basename(input.sessionFile),
		);
		if (session.projectDir !== (await canonicalProjectDir(input.projectDir)) || session.sessionFile !== sessionFile)
			throw new DiscordModeError(
				"Persistent session UUID is bound to a different project directory or session file.",
			);
		if (this.#live(session)) {
			if (!session.host)
				throw new DiscordModeError("Another terminal holds this conversation's Discord connection.");
			if (!this.#stepAside.has(session.id)) this.#stepAside.set(session.id, { at: Date.now() });
		}
		return this.#snapshot(session);
	}

	/** The terminal closes but its conversation keeps running: start a background copy, then drop this lease. */
	async #background(session: Session): Promise<ModeSnapshot> {
		if (!this.#hosts)
			throw new DiscordModeError("This Discord service can't keep conversations running in the background.");
		if ((session.app ?? "haiso") !== "haiso")
			throw new DiscordModeError("Only Haiso conversations can keep running in the background.");
		await this.#reconcileSession(session);
		this.#requireRemote(session);
		await this.#launch(
			{
				kind: "resume",
				groupId: session.groupId,
				sessionId: session.id,
				name: `haiso-s-${session.id}`,
				channelId: session.channelId!,
			},
			{ projectDir: session.projectDir, sessionFile: session.sessionFile },
		);
		// The copy waits for this terminal to release the conversation, then claims the launch.
		this.#revoke(session);
		await this.#persist();
		await this.#cards(this.#group(session.groupId));
		return this.#snapshot(session);
	}

	/**
	 * Launches whose copy stopped before claiming them failed to start: say so where the owner asked. A copy still
	 * starting when its launch expires is stopped.
	 */
	async #checkLaunches(): Promise<void> {
		const hosts = this.#hosts;
		const launches = this.#journal.launches ?? [];
		const now = Date.now();
		if (!hosts || !launches.some(launch => now - launch.createdAt >= DISCORD_MODE_LAUNCH_GRACE_MS)) return;
		let running: string[];
		try {
			running = await hosts.running();
		} catch {
			return;
		}
		const failed = launches.filter(
			launch =>
				now - launch.createdAt >= DISCORD_MODE_LAUNCH_GRACE_MS &&
				(!running.includes(launch.name) || now - launch.createdAt >= DISCORD_MODE_LAUNCH_TTL_MS),
		);
		if (!failed.length) return;
		this.#journal.launches = launches.filter(launch => !failed.includes(launch));
		await this.#persist();
		for (const launch of failed) {
			if (running.includes(launch.name)) await hosts.stop(launch.name).catch(() => {});
			const label = launch.label ?? this.#journal.sessions.find(session => session.id === launch.sessionId)?.label;
			try {
				await this.#external(() =>
					this.#port.publish(
						launch.channelId,
						`Couldn't start ${label ?? "the conversation"} in the background: it stopped before reconnecting to Discord. Check that its model and project still open at your desk, then try again.`,
						`launch-failed:${launch.id}`,
					),
				);
			} catch {
				/* Its card reads Closed again either way. */
			}
			const group = this.#journal.groups.find(item => item.id === launch.groupId);
			if (group) await this.#cards(group);
		}
	}

	/** A copy asked to leave that stays idle without leaving (a stuck exit) is stopped gracefully by its supervisor. */
	async #checkStepAside(): Promise<void> {
		const hosts = this.#hosts;
		if (!hosts) return;
		for (const [sessionId, leaving] of this.#stepAside) {
			const session = this.#journal.sessions.find(item => item.id === sessionId);
			if (!session?.host || !this.#live(session)) {
				this.#stepAside.delete(sessionId);
				continue;
			}
			if (
				leaving.stopped ||
				leaving.idleSince === undefined ||
				Date.now() - leaving.idleSince < DISCORD_MODE_STEP_ASIDE_STOP_MS
			)
				continue;
			leaving.stopped = true;
			await hosts.stop(session.host).catch(() => {});
		}
	}

	/** One best-effort saved-message notice; never repeated for its key, never fails the caller. */
	async #notice(session: Session, text: string, key: string, actions: ModeNoticeAction[]): Promise<void> {
		const channelId = session.channelId;
		if (!channelId || !this.#gateway || session.state !== "ready") return;
		try {
			await this.#perform(`notice:${key}`, { channelId, text }, () =>
				this.#external(() => this.#port.notice(channelId, text, key, session.connectionId, actions)),
			);
		} catch {
			/* The session card's queue count and the next resume still surface saved messages. */
		}
	}

	async #dialog(session: Session, input: Extract<ModeRequest, { op: "dialog" }>): Promise<void> {
		await this.#reconcileSession(session);
		this.#requireRemote(session);
		if (input.dialog.kind === "select" && !input.dialog.options?.length)
			throw new DiscordModeError("Select dialog requires current options.");
		const key = `dialog:${session.id}:${session.connectionId}:${input.dialog.id}`;
		if (
			!this.#journal.operations[digest(key)] &&
			this.#journal.dialogs.filter(item => item.sessionId === session.id).length >= MAX_DIALOGS
		)
			throw new DiscordModeError("Session has eight pending dialogs; resolve existing local dialogs first.");
		this.#checkPayload(Buffer.byteLength(JSON.stringify(input.dialog)));
		await this.#perform(key, input, async () => {
			const mention = this.#dialogMention(session);
			this.#journal.dialogs.push({
				sessionId: session.id,
				connectionId: session.connectionId,
				dialog: input.dialog,
				state: "pending",
			});
			await this.#persist();
			await this.#external(
				() =>
					this.#port.showDialog(
						session.channelId!,
						{ ...input.dialog, id: digest([session.id, session.connectionId, input.dialog.id]) },
						{ mention },
					),
				session,
			);
		});
	}

	/** Needs-you ping only when this dialog starts a new exchange; re-renders and concurrent dialogs stay silent. */
	#dialogMention(session: Session): boolean {
		if ((session.notify ?? "needs-you") === "off") return false;
		if (this.#journal.dialogs.some(item => item.sessionId === session.id)) return false;
		const ended = this.#dialogEnded.get(session.id);
		return ended === undefined || Date.now() - ended >= DIALOG_MENTION_GRACE_MS;
	}

	/** Final owner-turn replies ping in `all` mode, or in `needs-you` once the owner waited at least LONG_TURN_MS. */
	#replyMention(session: Session, delivery: Delivery, state: "accepted" | "completed" | "rejected"): boolean {
		if (delivery.source !== "owner" || state !== "completed") return false;
		const notify = session.notify ?? "needs-you";
		return (
			notify === "all" || (notify === "needs-you" && Date.now() - delivery.createdAt >= DISCORD_MODE_LONG_TURN_MS)
		);
	}

	async #answer(raw: Parameters<DiscordPortHandlers["answer"]>[0]): Promise<string> {
		await this.#expire();
		const input = RemoteAnswerShape.assert(raw);
		if (input.ownerId !== this.#config.ownerId)
			throw new DiscordModeError("Only the configured owner can answer native dialogs.");
		await this.#consumeRetirements();
		const session = this.#journal.sessions.find(item => item.channelId === input.channelId);
		if (!session) throw new DiscordModeError("Dialog channel is no longer bound.");
		if (session.retirement)
			throw new DiscordModeError("This conversation was permanently deleted; old dialog answers are rejected.");
		await this.#reconcileSession(session);
		this.#requireRemote(session);
		const pending = this.#journal.dialogs.find(
			item =>
				item.sessionId === session.id &&
				item.connectionId === session.connectionId &&
				digest([session.id, session.connectionId, item.dialog.id]) === input.dialogId,
		);
		if (!pending || pending.state !== "pending")
			throw new DiscordModeError("Dialog is stale, ended, or already answered; use the current native dialog.");
		if (!input.cancelled) {
			if (pending.dialog.kind === "confirm" ? typeof input.value !== "boolean" : typeof input.value !== "string")
				throw new DiscordModeError("Answer type does not match the current native dialog.");
			if (
				pending.dialog.kind === "select" &&
				(typeof input.value !== "string" || !pending.dialog.options?.includes(input.value))
			)
				throw new DiscordModeError("Choose an exact current dialog option.");
		}
		pending.state = "answered";
		pending.answer = { id: pending.dialog.id, value: input.value, cancelled: input.cancelled };
		await this.#persist();
		return "Answer queued for this session connection only; the first local or remote answer wins.";
	}

	async #endDialog(session: Session, dialogId: string): Promise<void> {
		const before = this.#journal.dialogs.length;
		this.#journal.dialogs = this.#journal.dialogs.filter(
			item =>
				!(
					item.sessionId === session.id &&
					item.connectionId === session.connectionId &&
					item.dialog.id === dialogId
				),
		);
		if (this.#journal.dialogs.length !== before) this.#dialogEnded.set(session.id, Date.now());
		await this.#persist();
		if (!session.channelId || !this.#gateway || session.state !== "ready") return;
		await this.#perform(
			`dialog-end:${session.id}:${session.connectionId}:${dialogId}`,
			{ sessionId: session.id, connectionId: session.connectionId, dialogId },
			async () => {
				await this.#external(() =>
					this.#port.endDialog(session.channelId!, digest([session.id, session.connectionId, dialogId])),
				);
			},
		);
	}

	async #rename(session: Session, input: Extract<ModeRequest, { op: "rename" }>): Promise<void> {
		await this.#reconcileSession(session);
		this.#requireRemote(session);
		const binding = input.target === "session" ? session : this.#group(session.groupId);
		const channelId = input.target === "session" ? session.channelId : this.#group(session.groupId).categoryId;
		if (!channelId) throw new DiscordModeError("Cannot rename an unbound resource; repair explicitly.");
		let name = input.name;
		if (input.target === "session")
			try {
				name = sessionChannelName(input.name, session.app);
			} catch {
				throw new DiscordModeError(
					"Choose a session name containing usable letters, numbers, underscores, or hyphens.",
				);
			}
		await this.#perform(`request:${session.id}:${input.requestId}`, input, async () => {
			await this.#external(() => this.#port.rename(channelId, name), binding);
			if (input.target === "session") await this.#reconcileSession(session);
			else await this.#reconcileGroup(this.#group(session.groupId));
		});
		await this.#cards(this.#group(session.groupId));
	}

	async #repair(session: Session, input: Extract<ModeRequest, { op: "repair" }>): Promise<void> {
		if (!this.#gateway)
			throw new DiscordModeError("Discord is offline; reconnect before inspecting or repairing bindings.");
		const group = this.#group(session.groupId);
		const binding = input.target === "session" ? session : group;
		await this.#reconcileGroup(group);
		await this.#reconcileSession(session, false);
		let destination: RemoteChannel | undefined;
		if (input.destinationId) {
			const inspected = await this.#inspect(input.destinationId);
			if (inspected.state !== "found")
				throw new DiscordModeError(
					"Repair destination is missing or inaccessible; choose an inspectable private resource.",
				);
			destination = inspected.channel;
			this.#validateRemote(
				destination,
				input.target === "group" ? "category" : "text",
				input.target === "session" ? group.categoryId : undefined,
			);
			this.#assertUnbound(destination.id, binding.id);
		} else if (binding.uncertain)
			throw new DiscordModeError(
				"Prior mutation has an unknown outcome. Inspect Discord and explicitly adopt its resource by destination ID; blind replacement is forbidden.",
			);
		else if (binding.state === "inaccessible" || binding.state === "moved")
			throw new DiscordModeError(
				"Existing resource still exists or is inaccessible; restore its privacy/location or explicitly select a valid private destination.",
			);
		if (input.target === "session" && group.state !== "ready")
			throw new DiscordModeError("Repair the project category/overview before the session channel.");
		if (input.target === "session" && !destination && session.state !== "ready")
			this.#requireCategoryCapacity(group, session.id);
		const selected = destination;
		await this.#perform(`request:${session.id}:${input.requestId}`, input, async () => {
			this.#hold(binding);
			if (input.target === "session") {
				if (selected) {
					session.channelId = selected.id;
					session.label = sessionLabel(selected.name) ?? session.label;
					session.uncertain = false;
					session.state = "ready";
					await this.#relabel(session, selected);
				} else if (session.state !== "ready") await this.#createSession(session, group);
				this.#resumeQueue(session, input.resumeQueued);
				this.#journal.dialogs = this.#journal.dialogs.filter(item => item.sessionId !== session.id);
			} else {
				await this.#repairGroup(group, selected);
				for (const member of this.#journal.sessions)
					if (member.groupId === group.id && !member.retirement) this.#resumeQueue(member, input.resumeQueued);
				this.#journal.dialogs = this.#journal.dialogs.filter(
					item => this.#session(item.sessionId).groupId !== group.id,
				);
			}
			this.#journal.cards = this.#journal.cards.filter(
				card => card.channelId !== (input.target === "session" ? session.channelId : group.overviewId),
			);
			await this.#arrange(group);
		});
		await this.#cards(group);
	}

	async #repairGroup(group: Group, destination: RemoteChannel | undefined): Promise<void> {
		const previousCategory = group.categoryId;
		if (destination) {
			group.categoryId = destination.id;
			group.name = destination.name;
		} else if (!group.categoryId || (await this.#inspect(group.categoryId)).state === "missing") {
			group.uncertain = true;
			group.state = "uncertain";
			await this.#persist();
			const category = await this.#external(() => this.#port.createCategory(group.name), group);
			this.#validateRemote(category, "category");
			this.#assertUnbound(category.id, group.id);
			group.categoryId = category.id;
			group.name = category.name;
		}
		if (!group.categoryId) throw new DiscordModeError("Choose a private category to repair the project binding.");
		await this.#persist();
		// Only known surviving children move. Never touch unrelated channels or delete history.
		const childIds = [
			group.overviewId,
			...this.#journal.sessions
				.filter(item => item.groupId === group.id && !item.retirement)
				.map(item => item.channelId),
		];
		for (const childId of childIds)
			if (childId) {
				const child = await this.#inspect(childId);
				if (
					child.state === "found" &&
					child.channel.private &&
					child.channel.kind === "text" &&
					child.channel.parentId !== group.categoryId
				) {
					if (child.channel.parentId !== undefined && child.channel.parentId !== previousCategory) continue;
					await this.#external(() => this.#port.move(childId, group.categoryId!), group);
				}
			}
		const overview = group.overviewId ? await this.#inspect(group.overviewId) : undefined;
		if (!overview || overview.state === "missing") {
			// An unknown creation cannot be searched/adopted through the category-only API.
			// A new explicitly selected category establishes a fresh overview namespace.
			if (group.overviewUncertain && (!destination || destination.id === previousCategory))
				throw new DiscordModeError(
					"Overview creation outcome is unknown. Select a different private category explicitly; the old category/history will remain untouched.",
				);
			group.overviewUncertain = true;
			await this.#persist();
			const created = await this.#external(
				() => this.#port.createChannel(group.categoryId!, "overview", `haiso:group:${group.id}`),
				group,
			);
			this.#validateRemote(created, "text", group.categoryId);
			this.#assertUnbound(created.id);
			group.overviewId = created.id;
			group.overviewUncertain = false;
		}
		group.uncertain = false;
		await this.#reconcileGroup(group);
		for (const member of this.#journal.sessions)
			if (member.groupId === group.id && !member.retirement) await this.#reconcileSession(member, false);
	}

	#resumeQueue(session: Session, resume: boolean): void {
		if (!resume) return;
		for (const delivery of this.#journal.deliveries) {
			if (delivery.sessionId !== session.id || delivery.state !== "queued" || !delivery.held) continue;
			delivery.connectionId = session.connectionId;
			delivery.channelId = delivery.source === "owner" ? session.channelId : undefined;
			delivery.held = false;
		}
	}

	#hold(binding: Session | Group): void {
		for (const delivery of this.#journal.deliveries)
			if (
				delivery.source === "owner" &&
				delivery.state === "queued" &&
				(delivery.sessionId === binding.id || this.#session(delivery.sessionId).groupId === binding.id)
			)
				delivery.held = true;
	}

	async #inspect(id: string): Promise<ChannelInspection> {
		const deadline = Promise.withResolvers<ChannelInspection>();
		const timer = setTimeout(() => deadline.resolve({ state: "inaccessible" }), EFFECT_TIMEOUT_MS);
		try {
			return await Promise.race([this.#port.inspect(id), deadline.promise]);
		} catch {
			return { state: "inaccessible" };
		} finally {
			clearTimeout(timer);
		}
	}

	async #reconcileGroup(group: Group): Promise<void> {
		if (!this.#gateway) {
			group.state = "offline";
			this.#hold(group);
			return;
		}
		let state: BindingState = "unbound";
		if (group.categoryId) {
			const category = await this.#inspect(group.categoryId);
			state = inspectionState(category, "category");
			if (category.state === "found") group.name = category.channel.name;
			if (state === "ready")
				state = group.overviewId
					? inspectionState(await this.#inspect(group.overviewId), "text", group.categoryId)
					: "unbound";
		}
		group.state = group.uncertain ? "uncertain" : state;
		if (group.state !== "ready") this.#hold(group);
	}

	/** Returns the inspected session channel when found, so callers can relabel it in place. */
	async #reconcileSession(session: Session, includeGroup = true): Promise<RemoteChannel | undefined> {
		if (session.retirement) return;
		const group = this.#group(session.groupId);
		if (includeGroup) await this.#reconcileGroup(group);
		if (!this.#gateway) {
			session.state = "offline";
			this.#hold(session);
			return;
		}
		let state: BindingState = "unbound";
		let found: RemoteChannel | undefined;
		if (session.channelId) {
			const channel = await this.#inspect(session.channelId);
			state = inspectionState(channel, "text", group.categoryId);
			if (channel.state === "found") {
				found = channel.channel;
				session.label = sessionLabel(found.name) ?? session.label;
			}
		}
		session.state = session.uncertain ? "uncertain" : state;
		if (session.state !== "ready" || group.state !== "ready") this.#hold(session);
		return found;
	}

	/**
	 * Best-effort in-place rename to the app-marked name; never marks the binding uncertain.
	 * An unconfirmed attempt is not repeated for the same wanted name; an observed match re-arms it,
	 * so each owner edit that drops or swaps the marker is corrected exactly once.
	 */
	async #relabel(session: Session, channel: RemoteChannel | undefined): Promise<void> {
		const channelId = session.channelId;
		if (!channel || !channelId || session.retirement || session.state !== "ready") return;
		try {
			const wanted = sessionChannelName(session.label, session.app);
			if (channel.name === wanted) {
				this.#relabelled.delete(channelId);
				return;
			}
			if (this.#relabelled.get(channelId) === wanted) return;
			this.#relabelled.set(channelId, wanted);
			await this.#external(() => this.#port.rename(channelId, wanted));
		} catch {
			/* Labels without a usable slug and rate-limited renames keep the owner's name until the wanted name changes. */
		}
	}

	/** Best-effort category order: overview, Haiso sessions, then OMP sessions, each in enrollment order. */
	async #arrange(group: Group): Promise<void> {
		if (!this.#gateway || group.state !== "ready" || !group.categoryId || !group.overviewId) return;
		const sessions = this.#journal.sessions.filter(
			session =>
				session.groupId === group.id && !session.retirement && session.channelId && session.state === "ready",
		);
		const ordered = [group.overviewId];
		for (const app of ["haiso", "omp"] satisfies ModeApp[])
			for (const session of sessions) if ((session.app ?? "haiso") === app) ordered.push(session.channelId!);
		const categoryId = group.categoryId;
		try {
			await this.#external(() => this.#port.arrange(categoryId, ordered));
		} catch {
			/* Ordering is presentation only; the next reconcile retries. */
		}
	}

	#scheduleReconcile(): Promise<void> {
		if (this.#reconcilePending || !this.#running) return Promise.resolve();
		this.#reconcilePending = true;
		return this.#mutate(() => this.#reconcile(false))
			.catch(() => undefined)
			.finally(() => {
				this.#reconcilePending = false;
			});
	}

	#scheduleCatchUp(): void {
		if (this.#catchingUp || !this.#running) return;
		this.#catchingUp = true;
		void this.#mutate(() => this.#catchUp())
			.catch(() => undefined)
			.finally(() => {
				this.#catchingUp = false;
			});
	}

	/**
	 * Owner messages sent while the service or its gateway was away: fetched after each bound channel's watermark
	 * (bounded in count and age), saved like messages to a closed session, and offered once per channel; never run.
	 */
	async #catchUp(): Promise<void> {
		if (!this.#gateway) return;
		const floor = snowflakeAt(Date.now() - DISCORD_MODE_CATCH_UP_MS);
		const touched = new Set<Group>();
		for (const group of this.#journal.groups) await this.#reconcileGroup(group);
		for (const session of this.#journal.sessions) {
			const channelId = session.channelId;
			if (!channelId || session.retirement || !session.enabled) continue;
			await this.#reconcileSession(session, false);
			if (session.state !== "ready" || this.#group(session.groupId).state !== "ready") continue;
			const mark = this.#journal.watermarks?.[channelId];
			// First run with this channel: nothing is known to be missed, so start watching from now.
			if (mark === undefined) {
				this.#advanceWatermark(channelId, snowflakeAt(Date.now()));
				continue;
			}
			let messages: ModeOwnerMessage[];
			try {
				messages = await this.#external(() =>
					this.#port.history(channelId, BigInt(mark) > BigInt(floor) ? mark : floor, DISCORD_MODE_CATCH_UP_LIMIT),
				);
			} catch {
				continue;
			}
			let saved = 0;
			for (const raw of messages.slice(0, DISCORD_MODE_CATCH_UP_LIMIT)) {
				if (!OwnerMessageShape.allows(raw) || raw.channelId !== channelId || raw.ownerId !== this.#config.ownerId)
					continue;
				if (BigInt(raw.id) <= BigInt(mark)) continue;
				// Already received live (or by an earlier catch-up): the owner:<id> fence dedups it.
				const fresh =
					!raw.rejected &&
					raw.kind === "message" &&
					Text.allows(raw.text) &&
					!this.#journal.operations[digest(`owner:${raw.id}`)];
				if (fresh) {
					try {
						await this.#perform(`owner:${raw.id}`, raw, async () => {
							this.#enqueue(session, raw.ownerId, "owner", "message", raw.text, raw.id, true);
						});
					} catch {
						break; // A full budget stops here; the rest stays past the watermark for the next catch-up.
					}
					saved++;
				}
				this.#advanceWatermark(channelId, raw.id);
			}
			if (!saved) continue;
			touched.add(this.#group(session.groupId));
			await this.#notice(
				session,
				`${saved} message${saved === 1 ? "" : "s"} arrived while Haiso was offline.`,
				`catchup:${channelId}:${this.#journal.watermarks![channelId]}`,
				[
					{ action: "send-held", label: "Send now" },
					{ action: "discard-held", label: "Discard" },
				],
			);
		}
		await this.#persist();
		for (const group of touched) await this.#cards(group);
	}

	/** After a crash, each overview says once how long the service was away. */
	async #announceOffline(from: number): Promise<void> {
		const text = `Haiso's Discord service was offline from <t:${Math.floor(from / 1000)}:f> to <t:${Math.floor(Date.now() / 1000)}:f>; it stopped unexpectedly.`;
		for (const group of this.#journal.groups) {
			const overviewId = group.overviewId;
			if (!this.#gateway || group.state !== "ready" || !overviewId) continue;
			try {
				await this.#external(() => this.#port.publish(overviewId, text, `offline:${from}`));
			} catch {
				/* Informational only; the overview card already reads Online. */
			}
		}
	}

	/**
	 * Graceful stop: overview cards read `Offline since`, session cards `Closed`, as exact edits of the saved messages
	 * within the supervisor's stop grace. Their fingerprints are invalidated first, so the next start re-renders every
	 * one of them whether or not the edit landed.
	 */
	async #offlineCards(stoppedAt: number): Promise<void> {
		this.#stoppedAt = stoppedAt;
		const edits: Array<{ channelId: string; text: string; app?: ModeApp }> = [];
		for (const group of this.#journal.groups)
			if (group.state === "ready" && group.overviewId)
				edits.push({ channelId: group.overviewId, text: this.#overviewText(group) });
		for (const session of this.#journal.sessions)
			if (
				!session.retirement &&
				session.state === "ready" &&
				session.channelId &&
				this.#group(session.groupId).state === "ready"
			)
				edits.push({
					channelId: session.channelId,
					text: `${this.#sessionStatus(session)}\n${SESSION_CARD_FOOTER}`,
					app: session.app ?? "haiso",
				});
		const targets = edits.flatMap(edit => {
			const card = this.#journal.cards.find(item => item.channelId === edit.channelId);
			if (card?.state !== "done" || !card.messageId) return [];
			card.fingerprint = digest(["offline", stoppedAt, edit.channelId]);
			return [{ ...edit, messageId: card.messageId }];
		});
		await this.#persist();
		const deadline = Date.now() + STOP_CARDS_MS;
		for (const target of targets) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			const expired = Promise.withResolvers<void>();
			const timer = setTimeout(expired.resolve, remaining);
			try {
				await Promise.race([
					this.#port
						.status(
							target.channelId,
							target.text,
							`status:${target.channelId}`,
							undefined,
							target.messageId,
							true,
							target.app,
						)
						.catch(() => {}),
					expired.promise,
				]);
			} finally {
				clearTimeout(timer);
			}
		}
	}
	/** Adopt every matching local intent before any Discord effect or native routing. */
	async #consumeRetirements(requestedId?: string): Promise<void> {
		const root = path.dirname(this.#storePath);
		return withDiscordDeletionLock(root, () => this.#adoptRetirements(root, requestedId));
	}

	async #adoptRetirements(root: string, requestedId?: string): Promise<void> {
		const events = await readDiscordDeletionEvents(root);
		const adopted: ModeDeletionEvent[] = [];
		let rejected = false;
		for (const event of events) {
			const binding = event.binding;
			const session = this.#journal.sessions.find(item => item.id === binding.sessionId);
			const projectDir = await canonicalProjectDir(binding.projectDir);
			const sessionFile = path.join(
				await canonicalProjectDir(path.dirname(binding.sessionFile)),
				path.basename(binding.sessionFile),
			);
			if (
				!session ||
				binding.guildId !== this.#config.guildId ||
				binding.ownerId !== this.#config.ownerId ||
				projectDir !== session.projectDir ||
				sessionFile !== session.sessionFile ||
				binding.channelId !== session.channelId ||
				this.#journal.sessions.some(item => item.id !== session.id && item.retirement?.eventId === event.id)
			) {
				if (event.id === requestedId) rejected = true;
				continue;
			}
			if (session.retirement) {
				const retirement = session.retirement;
				if (
					retirement.eventId !== event.id ||
					retirement.policy !== event.policy ||
					retirement.deletedAt !== event.createdAt ||
					retirement.channelId !== binding.channelId
				) {
					if (event.id === requestedId) rejected = true;
					continue;
				}
			} else {
				// A prepared intent is authoritative only after an accessible parent proves
				// the exact native file absent. No sweep ever manufactures deletion intent.
				if (event.phase === "prepared" && !(await isDiscordDeletedSessionFile(session.sessionFile))) continue;
				session.retirement = {
					eventId: event.id,
					policy: event.policy,
					deletedAt: event.createdAt,
					state: "pending",
					channelId: binding.channelId,
				};
				this.#revoke(session);
				session.enabled = false;
				session.busy = false;
				session.pendingInput = false;
				this.#journal.deliveries = this.#journal.deliveries.filter(
					item => item.sessionId !== session.id && !(item.source === "peer" && item.from === session.id),
				);
				// Persist before the next fallible event read/check; an unrelated bad
				// intent must never leave an adopted in-memory fence without durability.
				await this.#persist();
			}
			adopted.push(event);
		}
		// The tombstone contains the complete immutable authority after adoption.
		// Never remove the outbox entry until these routing fences are durable.
		for (const event of adopted) {
			try {
				await discardDiscordDeletionEvent(event, root);
			} catch {
				// A replacement or temporarily inaccessible outbox entry remains fenced.
			}
		}
		if (rejected)
			throw new DiscordModeError("Deletion event conflicts with its exact saved binding or adopted retirement.");
	}

	async #reconcileRetirement(session: Session): Promise<void> {
		const retirement = session.retirement!;
		if (retirement.state === "done") return;
		const channelId = retirement.channelId;
		const attention = async (error: string): Promise<void> => {
			retirement.state = "attention";
			retirement.error = error;
			await this.#persist();
		};
		if (channelId !== session.channelId) {
			await attention("Saved retirement target changed; no Discord channel was touched.");
			return;
		}
		if (!channelId) {
			if (session.uncertain) {
				await attention(
					"Prior channel creation is unconfirmed; no exact target is known and no Discord resource was touched.",
				);
				return;
			}
			retirement.state = "done";
			delete retirement.error;
			await this.#persist();
			return;
		}
		if (!this.#gateway) {
			session.state = "offline";
			retirement.state = "pending";
			retirement.error = "Discord is offline; permanent local closure is effective and remote cleanup is pending.";
			await this.#persist();
			return;
		}
		// Reinspect the immutable target on every recovery attempt. The port additionally
		// verifies guild and original ownership before any PATCH/DELETE.
		const inspected = await this.#inspect(channelId);
		if (inspected.state === "missing") {
			session.state = "missing";
			retirement.state = "done";
			delete retirement.error;
			await this.#persist();
			return;
		}
		const marker = `haiso:session:${session.id}`;
		if (
			inspected.state !== "found" ||
			inspected.channel.id !== channelId ||
			!inspected.channel.private ||
			inspected.channel.kind !== "text" ||
			(inspected.channel.topic !== marker &&
				inspected.channel.topic !== `${marker} — Closed: native conversation permanently deleted.`)
		) {
			session.state = "inaccessible";
			await attention("Exact private channel ownership could not be verified; remote cleanup is pending.");
			return;
		}
		session.state = "ready";
		const card = this.#journal.cards.find(item => item.channelId === channelId);
		if (retirement.policy === "retain" && card?.messageId)
			await this.#card(channelId, this.#sessionStatus(session), undefined, true, session.app ?? "haiso");
		try {
			await this.#external(() => this.#port.retire(channelId, session.id, retirement.policy));
		} catch {
			await attention(
				"Discord retirement outcome is unconfirmed; the exact target will be inspected before recovery.",
			);
			return;
		}
		session.state = retirement.policy === "delete" ? "missing" : "ready";
		if (retirement.policy === "retain") {
			if (card?.messageId && card.state === "done") {
				await this.#card(channelId, this.#sessionStatus(session, true), undefined, true, session.app ?? "haiso");
			}
			if (!card?.messageId || card.state !== "done") {
				await attention(
					"Channel archived; final status-card confirmation is pending. Only the saved message may be updated; no replacement notice will be created.",
				);
				return;
			}
		}
		retirement.state = "done";
		delete retirement.error;
		await this.#persist();
	}

	async #reconcile(all: boolean): Promise<void> {
		await this.#expire();
		await this.#consumeRetirements();
		const groups = this.#journal.groups;
		const sessions = this.#journal.sessions;
		const total = groups.length + sessions.length;
		const count = all ? total : Math.min(16, total);
		const touched = new Set<string>();
		for (let index = 0; index < count; index++) {
			const selected = this.#cursor++ % total;
			if (selected < groups.length) {
				const group = groups[selected]!;
				await this.#reconcileGroup(group);
				touched.add(group.id);
			} else {
				const session = sessions[selected - groups.length]!;
				if (session.retirement) await this.#reconcileRetirement(session);
				else await this.#relabel(session, await this.#reconcileSession(session));
				touched.add(session.groupId);
			}
		}
		await this.#checkLaunches();
		await this.#checkStepAside();
		this.#journal.service = { heartbeatAt: Date.now() };
		await this.#persist();
		for (const groupId of touched) {
			const group = this.#group(groupId);
			await this.#arrange(group);
			await this.#cards(group);
		}
	}

	#sessionActivity(session: Session): string {
		if (session.retirement) return "Permanently deleted";
		if (!session.enabled) return "Off";
		if (!this.#live(session)) {
			if (this.#journal.launches?.some(launch => launch.sessionId === session.id))
				return "Starting in the background…";
			return this.#hosts && (session.app ?? "haiso") === "haiso"
				? "Closed · resume here or at your desk"
				: "Closed · resume at your desk";
		}
		const online = session.host ? "Online in the background" : "Online";
		if (session.pendingInput) return `${online} · Waiting for input`;
		return session.busy ? `${online} · Working` : `${online} · Idle`;
	}

	/** `progress` replaces the `<activity> · <state>` line on the session card; cards render only ready bindings. */
	#sessionStatus(session: Session, retirementComplete = false, progress?: string): string {
		if (session.retirement) {
			const retirement = session.retirement;
			return `${APP_TAGS[session.app ?? "haiso"]} · ${session.label}\nSession ${session.id}\nConversation permanently deleted. Nothing is forwarded; all controls and pending input are revoked.\nDiscord ${retirement.policy === "retain" ? "history retained" : "history deletion"} · ${retirementComplete ? "done" : retirement.state}${!retirementComplete && retirement.error ? `\n${retirement.error}` : ""}`;
		}
		let queued = 0;
		let active = 0;
		let uncertain = 0;
		for (const delivery of this.#journal.deliveries) {
			if (delivery.sessionId !== session.id) continue;
			if (delivery.state === "queued") queued++;
			else if (delivery.state === "accepted" || delivery.state === "dispatched") active++;
			else if (delivery.state === "unknown") uncertain++;
		}
		return `${APP_TAGS[session.app ?? "haiso"]} · ${session.label}\nSession ${session.id}\nProject ${this.#group(session.groupId).name}\n${progress ?? `${this.#sessionActivity(session)} · ${session.state}`}\nQueued ${queued} · active ${active} · uncertain ${uncertain}\nNotifications: ${session.notify ?? "needs-you"}`;
	}

	async #cards(group: Group): Promise<void> {
		if (!this.#gateway || group.state !== "ready") return;
		const members = this.#journal.sessions.filter(session => session.groupId === group.id && !session.retirement);
		if (group.overviewId) await this.#card(group.overviewId, this.#overviewText(group));
		for (const session of members) await this.#sessionCard(session);
	}

	/** Overview card: service liveness, then one section per app, Haiso first to match channel order. */
	#overviewText(group: Group): string {
		const members = this.#journal.sessions.filter(session => session.groupId === group.id && !session.retirement);
		const sections = (["haiso", "omp"] satisfies ModeApp[]).flatMap(app => {
			const rows = members
				.filter(session => (session.app ?? "haiso") === app)
				.map(
					session =>
						`${session.channelId ? `<#${session.channelId}>` : session.label} · ${session.id} · ${this.#sessionActivity(session)} · ${session.state}`,
				);
			return rows.length ? [`\n${APP_TAGS[app]} sessions\n${rows.join("\n")}`] : [];
		});
		const service =
			this.#stoppedAt === undefined
				? "Online"
				: this.#updating
					? "Updating — back in a moment"
					: `Offline since <t:${Math.floor(this.#stoppedAt / 1000)}:f>`;
		return `Haiso · ${group.name}\n${group.projectDir}\nDiscord service: ${service}\n${sections.join("\n")}`;
	}

	/** One session's card, with its live progress line while it is working. */
	async #sessionCard(session: Session): Promise<void> {
		if (
			!this.#gateway ||
			session.retirement ||
			session.state !== "ready" ||
			!session.channelId ||
			this.#group(session.groupId).state !== "ready"
		)
			return;
		const progress = this.#progress.get(session.id);
		const activity = this.#sessionActivity(session);
		// The progress line (`Working · 4m · …`) takes the place of the activity's `Working`, keeping its prefix.
		const line =
			progress?.connectionId === session.connectionId && progress.shown && activity.endsWith("Working")
				? `${activity.slice(0, -"Working".length)}${progress.shown}`
				: undefined;
		await this.#card(
			session.channelId,
			`${this.#sessionStatus(session, false, line)}\n${SESSION_CARD_FOOTER}`,
			this.#controlConnection(session),
			false,
			session.app ?? "haiso",
			this.#hosts !== undefined && this.#resumable(session),
		);
	}

	async #card(
		channelId: string,
		text: string,
		connectionId?: string,
		existingOnly = false,
		app?: ModeApp,
		/** Closed session card with [Resume]; only brokers that can start background copies set it. */
		resumable = false,
	): Promise<void> {
		const fingerprint = digest(resumable ? [text, connectionId, app, resumable] : [text, connectionId, app]);
		let card = this.#journal.cards.find(item => item.channelId === channelId);
		// Only exact saved-message replacement is retryable. This mode cannot create
		// a notice when inspection fails or the saved message has disappeared.
		if (existingOnly && !card?.messageId) return;
		if (
			card &&
			((!existingOnly && card.state !== "done") ||
				(card.state === "done" && card.messageId && card.fingerprint === fingerprint))
		)
			return;
		if (!card) {
			// Replaced bindings retain history; permanent retirement keeps its card fence.
			this.#journal.cards = this.#journal.cards.filter(
				item =>
					this.#journal.groups.some(group => group.overviewId === item.channelId) ||
					this.#journal.sessions.some(session => session.channelId === item.channelId),
			);
			card = { channelId, fingerprint, state: "working" };
			this.#journal.cards.push(card);
		} else {
			card.fingerprint = fingerprint;
			card.state = "working";
		}
		await this.#persist();
		const previousMessageId = card.messageId;
		try {
			const messageId = await this.#external(() =>
				this.#port.status(
					channelId,
					text,
					`status:${channelId}`,
					connectionId,
					previousMessageId,
					existingOnly,
					app,
					resumable,
				),
			);
			if (existingOnly && messageId !== previousMessageId)
				throw new DiscordModeError("Saved status-card identity changed; no replacement was adopted.");
			card.messageId = RemoteId.assert(messageId);
			card.state = "done";
		} catch {
			card.state = "unknown";
		}
		await this.#persist();
	}

	/**
	 * Stops taking work, atomically with every other request, only when nothing is in flight and nothing was for
	 * DISCORD_MODE_SWITCH_QUIET_MS: no busy or input-waiting session, no dispatched, accepted, or dispatchable delivery,
	 * no open dialog, no pending settings change, no Discord event being handled. The caller then closes the service to
	 * run the updated release; until then every request is refused as "restarting for an update".
	 */
	stopIfQuiescent(): Promise<boolean> {
		return this.#mutate(async () => {
			const live = new Set(this.#journal.sessions.filter(session => this.#live(session)).map(session => session.id));
			const quiet =
				Date.now() - this.#activeAt >= DISCORD_MODE_SWITCH_QUIET_MS &&
				// This mutation is the only one queued.
				this.#backlog === 1 &&
				!this.#reconcilePending &&
				!this.#catchingUp &&
				!this.#port.busy?.() &&
				!this.#journal.dialogs.length &&
				![...this.#commands.values()].some(queue => queue.length) &&
				!this.#journal.sessions.some(session => live.has(session.id) && (session.busy || session.pendingInput)) &&
				!this.#journal.deliveries.some(
					delivery =>
						delivery.state === "dispatched" ||
						delivery.state === "accepted" ||
						(delivery.state === "queued" && !delivery.held && live.has(delivery.sessionId)),
				);
			if (!quiet) return false;
			this.#running = false;
			this.#updating = true;
			return true;
		}).catch(() => false);
	}

	/** Places the pinned guide once per process on a connected gateway; a failed attempt retries on reconnect. */
	#scheduleGuide(): Promise<void> {
		if (
			!this.#guide ||
			!this.#port.guide ||
			this.#guidePlaced ||
			this.#guidePending ||
			!this.#gateway ||
			!this.#running
		)
			return Promise.resolve();
		this.#guidePending = true;
		return this.#mutate(() => this.#maintainGuide())
			.catch(() => {})
			.finally(() => {
				this.#guidePending = false;
			});
	}

	/** Ensures the guide; after an update that changed it (never on the first start), posts one what's-new note. */
	async #maintainGuide(): Promise<void> {
		const guide = this.#guide;
		if (!guide || this.#guidePlaced || !this.#gateway) return;
		const saved = this.#journal.guide;
		const note =
			saved?.hash !== undefined && saved.hash !== guide.hash
				? { text: discordGuideWhatsNew(saved, guide), key: `whatsnew:${guide.hash}` }
				: undefined;
		const placement = await this.#external(async () =>
			this.#port.guide?.({
				text: guide.text,
				...(saved?.channelId && saved.messageId
					? { saved: { channelId: saved.channelId, messageId: saved.messageId } }
					: {}),
				exclude: this.#journal.groups.flatMap(group => group.categoryId ?? []),
				...(note ? { note } : {}),
			}),
		);
		this.#guidePlaced = true;
		this.#journal.guide = {
			...(placement ? { channelId: placement.channelId, messageId: placement.messageId } : {}),
			hash: guide.hash,
			commands: guide.commands,
			sections: guide.sections,
			...(this.#service ? { version: this.#service.version } : {}),
		};
		await this.#persist();
	}

	#snapshot(session: Session, lease = false): ModeSnapshot {
		return {
			group: publicGroup(this.#group(session.groupId)),
			session: publicSession(session),
			peers: this.#journal.sessions
				.filter(item => item.groupId === session.groupId && item.id !== session.id && !item.retirement)
				.map(publicSession),
			...(lease
				? { lease: { sessionId: session.id, connectionId: session.connectionId, token: session.token } }
				: {}),
			deliveries: [],
			answers: [],
			gatewayConnected: this.#gateway,
			maxReply: DISCORD_MODE_MAX_REPLY,
			settingsRevision: this.#settingsFor(session)?.view?.revision ?? "",
			progress: true,
			...(this.#hosts ? { background: true as const } : {}),
			...(this.#stepAside.has(session.id) ? { stepAside: true as const } : {}),
			...(this.#service ? { service: { ...this.#service } } : {}),
		};
	}

	#session(id: string): Session {
		const session = this.#journal.sessions.find(item => item.id === id);
		if (!session) throw new DiscordModeError("Unknown enrolled session UUID.");
		return session;
	}

	#group(id: string): Group {
		const group = this.#journal.groups.find(item => item.id === id);
		if (!group) throw new DiscordModeError("Unknown project group.");
		return group;
	}

	#validateRemote(channel: RemoteChannel, kind: RemoteChannel["kind"], parentId?: string): void {
		RemoteId.assert(channel.id);
		Label.assert(channel.name);
		if (channel.kind !== kind || !channel.private || (parentId !== undefined && channel.parentId !== parentId))
			throw new UnknownEffect(
				"Discord returned an incorrectly typed, insecure, or moved resource; inspect and explicitly repair the binding.",
			);
	}

	#assertUnbound(id: string, ownId?: string): void {
		if (
			this.#journal.groups.some(
				group => group.id !== ownId && (group.categoryId === id || group.overviewId === id),
			) ||
			this.#journal.sessions.some(session => session.id !== ownId && session.channelId === id)
		)
			throw new DiscordModeError(
				"Destination is already bound to another group or session; competing bindings are forbidden.",
			);
	}

	#checkPayload(extra: number): void {
		let used = extra;
		for (const delivery of this.#journal.deliveries) used += Buffer.byteLength(delivery.text);
		for (const dialog of this.#journal.dialogs) used += Buffer.byteLength(JSON.stringify(dialog));
		if (used > MAX_PAYLOAD_BYTES)
			throw new DiscordModeError(
				"Discord pending payload budget is full (8 MiB). Resolve pending work before sending more; no accepted payload was discarded.",
			);
	}

	#checkJournal(): void {
		const unique = (values: string[]) => new Set(values).size === values.length;
		if (
			!unique(this.#journal.groups.map(item => item.id)) ||
			!unique(this.#journal.groups.map(item => item.projectDir)) ||
			!unique(this.#journal.sessions.map(item => item.id)) ||
			!unique(this.#journal.sessions.map(item => item.sessionFile)) ||
			!unique(this.#journal.deliveries.map(item => item.id)) ||
			!unique(this.#journal.sessions.flatMap(item => (item.retirement ? [item.retirement.eventId] : [])))
		)
			throw new DiscordModeError("Discord journal contains duplicate persistent identities.");
		const channels = [
			...this.#journal.groups.flatMap(group => [group.categoryId, group.overviewId]),
			...this.#journal.sessions.map(session => session.channelId),
		].filter((id): id is string => id !== undefined);
		if (!unique(channels)) throw new DiscordModeError("Discord journal has competing resource bindings.");
		for (const session of this.#journal.sessions) {
			if (this.#group(session.groupId).projectDir !== session.projectDir)
				throw new DiscordModeError("Session project is inconsistent with its canonical group.");
			if (
				session.retirement &&
				(session.retirement.channelId !== session.channelId ||
					session.enabled ||
					session.connected ||
					session.busy ||
					session.pendingInput ||
					this.#journal.deliveries.some(
						item => item.sessionId === session.id || (item.source === "peer" && item.from === session.id),
					) ||
					this.#journal.dialogs.some(item => item.sessionId === session.id))
			)
				throw new DiscordModeError("Retired session journal contains a changed target or active routing state.");
		}
		for (const delivery of this.#journal.deliveries) {
			const recipient = this.#session(delivery.sessionId);
			if (delivery.source === "peer" && this.#session(delivery.from).groupId !== recipient.groupId)
				throw new DiscordModeError("Retained peer delivery crosses project boundaries.");
			if (delivery.source === "owner" && delivery.from !== this.#config.ownerId)
				throw new DiscordModeError("Retained delivery does not belong to configured owner.");
		}
		for (const dialog of this.#journal.dialogs) this.#session(dialog.sessionId);
		this.#checkPayload(0);
	}
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function equalTokens(left: string, right: string): boolean {
	return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
/** The smallest Discord snowflake at `time`: every message sent at or after it has a larger id. */
function snowflakeAt(time: number): string {
	const since = BigInt(Math.floor(time)) - DISCORD_EPOCH;
	return since > 0n ? (since << 22n).toString() : "0";
}
function publicGroup(group: Group): ModeGroup {
	const { uncertain: _uncertain, overviewUncertain: _overviewUncertain, ...result } = group;
	return result;
}
function publicSession(session: Session): ModeSession {
	const { token: _token, seenAt: _seenAt, uncertain: _uncertain, ...result } = session;
	return result;
}
function publicDelivery(delivery: Delivery): ModeDelivery {
	const {
		connectionId: _connectionId,
		channelId: _channelId,
		sourceMessageId: _sourceMessageId,
		...result
	} = delivery;
	return result;
}
function inspectionState(inspection: ChannelInspection, kind: RemoteChannel["kind"], parentId?: string): BindingState {
	if (inspection.state !== "found") return inspection.state;
	if (inspection.channel.kind !== kind || !inspection.channel.private) return "inaccessible";
	if (parentId !== undefined && inspection.channel.parentId !== parentId) return "moved";
	return "ready";
}
