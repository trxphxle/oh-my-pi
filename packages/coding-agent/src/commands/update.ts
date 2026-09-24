/**
 * Check for and install updates.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { updateHelp as commandHelp } from "../cli/command-help";
import * as pluginCli from "../cli/plugin-cli";
import * as updateCli from "../cli/update-cli";
import { CliUsageError } from "../cli/usage-error";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

export default class Update extends Command {
	static description = commandHelp.description;
	static flags = {
		force: Flags.boolean({
			char: "f",
			description: "Retry staging or rebuild the same pinned release; never bypass verification",
			default: false,
		}),
		check: Flags.boolean({
			char: "c",
			description: "Check the latest stable release without staging or activating it",
			default: false,
		}),
		plugins: Flags.boolean({ char: "l", description: "Update installed plugins", default: false }),
		stage: Flags.boolean({ description: "Build and verify a candidate without activating it", default: false }),
		apply: Flags.string({ description: "Activate the verified candidate with this exact ID" }),
		rollback: Flags.boolean({ description: "Activate the retained compatible previous release", default: false }),
		status: Flags.boolean({
			description: "Show installed release, automatic updates, and held candidates",
			default: false,
		}),
		auto: Flags.string({ description: "Enable or disable guarded automatic updates", options: ["on", "off"] }),
		reviewed: Flags.boolean({
			description: "Acknowledge reviewed state/broker changes for --apply or --rollback; never bypass checks",
			default: false,
		}),
		canary: Flags.boolean({ description: "Select canary updates (not supported by Haiso)", default: false }),
		stable: Flags.boolean({ description: "Select the stable upstream release channel", default: false }),
	};

	static examples = [
		`${APP_NAME} update --check`,
		`${APP_NAME} update --stage`,
		`${APP_NAME} update --status`,
		`${APP_NAME} update --apply <candidate-id>`,
		`${APP_NAME} update --auto on`,
		`${APP_NAME} update --rollback`,
		`${APP_NAME} update --plugins`,
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Update);
		if (flags.canary && flags.stable) throw new CliUsageError("--canary and --stable are mutually exclusive");
		const actions =
			Number(flags.check) +
			Number(flags.stage) +
			Number(flags.apply !== undefined) +
			Number(flags.rollback) +
			Number(flags.status) +
			Number(flags.auto !== undefined) +
			Number(flags.plugins);
		if (actions > 1)
			throw new CliUsageError(
				"--check, --stage, --apply, --rollback, --status, --auto, and --plugins are mutually exclusive",
			);
		if (flags.reviewed && !flags.apply && !flags.rollback)
			throw new CliUsageError("--reviewed requires --apply <candidate-id> or --rollback");
		if (flags.auto !== undefined && flags.auto !== "on" && flags.auto !== "off")
			throw new CliUsageError("--auto must be on or off");
		if (flags.plugins && (flags.force || flags.canary || flags.stable))
			throw new CliUsageError("--plugins cannot be combined with application update flags");
		await initTheme();
		if (flags.plugins) {
			await pluginCli.runPluginCommand({ action: "upgrade", args: [], flags: {} });
		} else {
			await updateCli.runUpdateCommand({
				force: flags.force,
				check: flags.check,
				channel: flags.canary ? "canary" : flags.stable ? "stable" : undefined,
				stage: flags.stage,
				apply: flags.apply,
				rollback: flags.rollback,
				status: flags.status,
				auto: flags.auto,
				reviewed: flags.reviewed,
			});
		}
	}
}
