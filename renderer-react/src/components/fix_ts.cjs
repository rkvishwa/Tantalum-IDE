const fs = require('fs');

let c = fs.readFileSync('SettingsPage.tsx', 'utf8');

c = c.replace(/import \{ deleteFirmwareRelease, listFirmwareHistory, markFirmwareAsCurrent, uploadFirmwareRelease \} from '@\/lib\/firmware';\n/, '');
c = c.replace(/import type \{ BoardDocument, BoardInput, BoardSecret, FirmwareDocument \} from '@\/lib\/models';/, `import type { BoardDocument, BoardInput } from '@/lib/models';`);
c = c.replace(/import \{ calculateBoardStatus, formatBytes, nextSemver \} from '@\/lib\/utils';/, `import { calculateBoardStatus } from '@/lib/utils';`);
c = c.replace(/export function SettingsPage\(\[\^)]*\) \{/, `export function SettingsPage({ user }: SettingsPageProps) {`);

fs.writeFileSync('SettingsPage.tsx', c);
console.log("Done");
