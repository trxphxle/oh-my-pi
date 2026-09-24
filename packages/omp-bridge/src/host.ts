import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ModeDelivery, ModeEnrollment, ModeRequest, ModeSnapshot } from "@oh-my-pi/pi-wire/discord-mode";

export const BRIDGE_OWNER_MESSAGE_TYPE = "collab-prompt";
export const BRIDGE_PEER_MESSAGE_TYPE = "omp-bridge-peer";
export const BRIDGE_MESSAGE_SOURCE = "omp-bridge";

export interface BridgeHostState {
	sessionId: string;
	sessionFile: string | null;
	cwd: string;
	label: string | undefined;
	local: boolean;
	idle: boolean;
	pendingMessages: boolean;
	pendingInput: boolean;
	draft: boolean;
}

/** Public host actions only: no model/settings mutation or application internals. */
export interface BridgeHost {
	getState(): BridgeHostState;
	deliver(delivery: ModeDelivery, behavior: "nextTurn" | "steer"): void;
	abort(): void;
	setToolEnabled(enabled: boolean): Promise<void>;
	setStatus(text: string | undefined): void;
	notify(text: string, level: "info" | "warning" | "error"): void;
	schedule(callback: () => void, delayMs: number): () => void;
}

export interface BridgeConnection {
	request(input: ModeRequest, signal?: AbortSignal): Promise<ModeSnapshot>;
	lookup(projectDir: string, sessionId: string): Promise<ModeEnrollment | undefined>;
	close(): Promise<void>;
}

export interface BridgeAgentEnd {
	messages: AgentMessage[];
	willContinue?: boolean;
}

export interface BridgePeer {
	id: string;
	label: string;
	busy: boolean;
	pendingInput: boolean;
}
