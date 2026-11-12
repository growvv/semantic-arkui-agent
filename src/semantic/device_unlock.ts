import fs from 'fs';
import os from 'os';
import path from 'path';
import { Hdc } from '../device/hdc';

/**
 * Wake the screen and swipe the lock screen away.
 *
 * A test device without a passcode leaves the lock screen on a swipe up, so no
 * person has to be present for the common case. A device with a passcode keeps
 * the lock screen and the caller reports DEVICE_LOCKED.
 */
export async function unlockDevice(hdc: Hdc): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await hdc.excuteShellCommand('power-shell', 'wakeup');
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 600));
        const layout = await readLayout(hdc);
        if (!layout?.includes('ScreenLockRootComponent')) {
            return;
        }
        const size = layoutSize(layout);
        try {
            await hdc.excuteShellCommand(
                'uitest', 'uiInput', 'swipe',
                String(Math.round(size.x / 2)), String(Math.round(size.y * 0.83)),
                String(Math.round(size.x / 2)), String(Math.round(size.y * 0.33)), '300',
            );
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 700));
        const after = await readLayout(hdc);
        if (!after?.includes('ScreenLockRootComponent')) {
            return;
        }
    }
    throw new Error('DEVICE_LOCKED: unlock the test device (passcode required) and rerun.');
}

async function readLayout(hdc: Hdc): Promise<string | undefined> {
    try {
        const output = await hdc.excuteShellCommand('uitest', 'dumpLayout');
        const match = /DumpLayout saved to:(\S+)/.exec(output);
        if (!match) return undefined;
        const local = path.join(os.tmpdir(), `haptest-lockcheck-${process.pid}.json`);
        hdc.recvFile(match[1], local);
        return fs.readFileSync(local, 'utf8');
    } catch {
        return undefined;
    }
}

/** The dump carries the physical bounds, the only screen-size source that works on HarmonyOS. */
function layoutSize(layout: string): { x: number; y: number } {
    const match = /"bounds"\s*:\s*"\[\s*(\d+)\s*,\s*(\d+)\s*\]\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]"/.exec(layout);
    if (match) return { x: Number(match[3]), y: Number(match[4]) };
    return { x: 1080, y: 2406 };
}
