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
			description: "Show guidance; automatic application replacement is disabled",
			default: false,
		}),
		check: Flags.boolean({
			char: "c",
			description: "Show source update guidance without a remote version check",
			default: false,
		}),
		plugins: Flags.boolean({ char: "l", description: "Update installed plugins", default: false }),
		canary: Flags.boolean({ description: "Show guidance; upstream channel switching is disabled", default: false }),
		stable: Flags.boolean({ description: "Show guidance; upstream channel switching is disabled", default: false }),
	};

	static examples = [`${APP_NAME} update`, `${APP_NAME} update --plugins`];

	async run(): Promise<void> {
		const { flags } = await this.parse(Update);
		await initTheme();
		if (flags.canary && flags.stable) throw new CliUsageError("--canary and --stable are mutually exclusive");
		if (flags.plugins) {
			await pluginCli.runPluginCommand({ action: "upgrade", args: [], flags: {} });
		} else {
			await updateCli.runUpdateCommand({
				force: flags.force,
				check: flags.check,
				channel: flags.canary ? "canary" : flags.stable ? "stable" : undefined,
			});
		}
	}
}
