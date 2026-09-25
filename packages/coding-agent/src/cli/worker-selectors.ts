/**
 * Bootstrap-only worker selectors dispatched by the shared CLI entrypoint.
 *
 * Keep these strings independent of each worker's protocol module: the CLI must
 * recognize a worker before importing protocol/runtime graphs whose top-level
 * evaluation is unnecessary in an ordinary interactive process.
 */
/** Blob-broker selector shared by the CLI dispatcher and worker launcher. */
export const BLOB_BROKER_WORKER_ARG = "__omp_worker_blob_broker";
/** Discord-mode selector shared by the CLI dispatcher and worker launcher. */
export const DISCORD_MODE_WORKER_ARG = "__omp_worker_discord_mode";
/** Discord-service ensure selector; its string is the OMP bridge's contract (constants-only module). */
export { DISCORD_MODE_ENSURE_WORKER_ARG } from "@oh-my-pi/pi-wire/discord-mode";
/** Computer-worker selector shared by the CLI dispatcher and worker launcher. */
export const COMPUTER_WORKER_ARG = "__omp_worker_computer";
/** Daemon-broker selector shared by the CLI dispatcher and worker launcher. */
export const DAEMON_BROKER_WORKER_ARG = "__omp_worker_daemon_broker";
/** LSP-multiplexer selector shared by the CLI dispatcher and worker launcher. */
export const LSP_MUX_WORKER_ARG = "__omp_worker_lsp_mux";
/** Activity-worker selector shared by the CLI dispatcher and worker launcher. */
export const STATS_ACTIVITY_WORKER_ARG = "__omp_worker_stats_activity";
/** Terminal-output selector shared by the CLI dispatcher and worker launcher. */
export const TERMINAL_OUTPUT_WORKER_ARG = "__omp_worker_terminal_output";
