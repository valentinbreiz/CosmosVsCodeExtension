import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execWithPath } from './execution';

// Cross-platform cosmos executable detection
export function getCosmosToolsPath(): string | null {
    const home = os.homedir();
    const toolsDir = path.join(home, '.dotnet', 'tools');

    // Check for different executable names based on platform
    const executableNames = process.platform === 'win32'
        ? ['cosmos.exe', 'cosmos']
        : ['cosmos'];

    for (const name of executableNames) {
        const fullPath = path.join(toolsDir, name);
        if (fs.existsSync(fullPath)) {
            return fullPath;
        }
    }
    return null;
}

export function isCosmosToolsInstalled(): boolean {
    return getCosmosToolsPath() !== null;
}

// Platform info from cosmos
export interface PlatformInfo {
    platform: string;
    platformName: string;
    arch: string;
    packageManager: string;
    qemuDisplay: string;
    gdbCommand: string;
    arm64UefiBios: string | null;
    cosmosToolsPath: string | null;
}

let cachedPlatformInfo: PlatformInfo | null = null;

export function getPlatformInfo(): PlatformInfo {
    if (cachedPlatformInfo) {
        return cachedPlatformInfo;
    }

    // Try to get from cosmos
    if (isCosmosToolsInstalled()) {
        try {
            const result = execWithPath('cosmos info --json', { encoding: 'utf8', timeout: 5000 });
            cachedPlatformInfo = JSON.parse(result);
            return cachedPlatformInfo!;
        } catch {
            // Fall through to defaults
        }
    }

    // Fallback defaults based on Node.js process.platform
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    cachedPlatformInfo = {
        platform: isWindows ? 'windows' : isMac ? 'macos' : 'linux',
        platformName: isWindows ? 'Windows' : isMac ? 'macOS' : 'Linux',
        arch: process.arch === 'arm64' ? 'arm64' : 'x64',
        packageManager: isWindows ? 'choco' : isMac ? 'brew' : 'apt',
        qemuDisplay: isWindows ? 'sdl' : isMac ? 'cocoa' : 'gtk',
        gdbCommand: 'gdb',
        arm64UefiBios: null,
        cosmosToolsPath: null
    };

    return cachedPlatformInfo;
}
