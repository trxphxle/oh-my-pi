import { APP_DISPLAY_NAME } from "@oh-my-pi/pi-utils/dirs";
import rootLicense from "../tools/browser/relay/extension-assets/LICENSE.txt" with { type: "text" };
import thirdPartyNotices from "../tools/browser/relay/extension-assets/THIRD-PARTY-NOTICES.txt" with { type: "text" };

export function formatLicenseOutput(): string {
	return `${APP_DISPLAY_NAME} License and Third-Party Notices (based on OMP)\n\n${rootLicense.trimEnd()}\n\n${thirdPartyNotices.trimEnd()}\n`;
}
