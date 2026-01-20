import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

// Get PATH with dotnet tools directory included
export function getEnvWithDotnetTools(): NodeJS.ProcessEnv {
    const home = os.homedir();
    const dotnetToolsPath = path.join(home, '.dotnet', 'tools');
    const currentPath = process.env.PATH || '';
    const pathSeparator = process.platform === 'win32' ? ';' : ':';

    return {
        ...process.env,
        PATH: `${dotnetToolsPath}${pathSeparator}${currentPath}`
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
