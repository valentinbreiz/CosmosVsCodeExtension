import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

// Get the Cosmos tools base directory for the current platform
function getCosmosToolsPath(): string {
    const home = os.homedir();
    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
        return path.join(localAppData, 'Cosmos', 'Tools');
    }
    return path.join(home, '.cosmos', 'tools');
}

// Get PATH with dotnet tools and Cosmos installer tool directories included
export function getEnvWithDotnetTools(): NodeJS.ProcessEnv {
    const home = os.homedir();
    const dotnetToolsPath = path.join(home, '.dotnet', 'tools');
    const cosmosTools = getCosmosToolsPath();
    const currentPath = process.env.PATH || '';
    const sep = process.platform === 'win32' ? ';' : ':';

    // Add Cosmos installer tool subdirectories so tools are discoverable
    // even if the shell hasn't picked up PATH changes yet
    const extraPaths = [
        dotnetToolsPath,
        path.join(cosmosTools, 'bin'),
        path.join(cosmosTools, 'yasm'),
        path.join(cosmosTools, 'xorriso'),
        path.join(cosmosTools, 'lld'),
        path.join(cosmosTools, 'clang'),
        path.join(cosmosTools, 'make'),
        path.join(cosmosTools, 'x86_64-elf-tools', 'bin'),
        path.join(cosmosTools, 'aarch64-elf-tools', 'bin')
    ].join(sep);

    return {
        ...process.env,
        PATH: `${extraPaths}${sep}${currentPath}`
    };
}

export function execWithPath(command: string, options: { encoding: 'utf8'; timeout?: number; cwd?: string } = { encoding: 'utf8' }): string {
    try {
        // Use platform-appropriate shell
        const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
        return execSync(command, {
            ...options,
            env: getEnvWithDotnetTools(),
            shell: shell
        });
    } catch (e) {
        throw e;
    }
}

export function getCommandPath(command: string): string | null {
    try {
        const cmd = process.platform === 'win32' ? `where ${command}` : `which ${command}`;
        return execWithPath(cmd).split('\n')[0].trim();
    } catch {
        return null;
    }
}
