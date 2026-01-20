import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';
import { getProjectInfo } from '../utils/project';
import { getEnvWithDotnetTools } from '../utils/execution';
import { getBuildChannel } from '../utils/output';

export async function buildCommand(arch?: string) {
    const buildChannel = getBuildChannel();

    // Get project info first to use configured architecture as default
    const projectInfo = getProjectInfo();
    if (!projectInfo) {
        vscode.window.showErrorMessage('No Cosmos project found');
        return;
    }

    if (!arch) {
        // Use project's configured architecture as default
        arch = projectInfo.arch;
    }

    const config = await vscode.window.showQuickPick(
        [
            { label: 'Debug', description: 'Debug build with symbols' },
            { label: 'Release', description: 'Optimized release build' }
        ],
        { placeHolder: 'Select build configuration' }
    );

    if (!config) return;

    const projectDir = path.dirname(projectInfo.csproj);

    // Show output in the build channel
    buildChannel.show(true);
    buildChannel.clear();
    buildChannel.appendLine(`Building ${projectInfo.name} for ${arch} (${config.label})...`);
    buildChannel.appendLine('');

    // Use cosmos build for cross-platform support
    const buildArgs = [
        'build',
        '-p', projectDir,
        '-a', arch,
        '-c', config.label,
        '-v'  // Verbose for output channel
    ];

    buildChannel.appendLine(`> cosmos ${buildArgs.join(' ')}`);
    buildChannel.appendLine('');

    const buildProcess = spawn('cosmos', buildArgs, {
        cwd: projectDir,
        env: getEnvWithDotnetTools(),
        shell: true
    });

    // Strip ANSI escape codes for clean output in VS Code
    const stripAnsi = (str: string) => str.replace(/\x1b\[[0-9;]*m/g, '');

    buildProcess.stdout?.on('data', (data: Buffer) => {
        buildChannel.append(stripAnsi(data.toString()));
    });

    buildProcess.stderr?.on('data', (data: Buffer) => {
        buildChannel.append(stripAnsi(data.toString()));
    });

    buildProcess.on('close', (code) => {
        buildChannel.appendLine('');
        if (code === 0) {
            buildChannel.appendLine('Build completed successfully.');
            vscode.window.showInformationMessage(`Build completed: ${projectInfo.name} (${arch})`);
        } else {
            buildChannel.appendLine(`Build failed with exit code ${code}`);
            vscode.window.showErrorMessage(`Build failed with exit code ${code}`);
        }
    });

    buildProcess.on('error', (err) => {
        buildChannel.appendLine(`Error: ${err.message}`);
        vscode.window.showErrorMessage(`Build error: ${err.message}`);
    });
}
