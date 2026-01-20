import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';
import { getProjectInfo } from '../utils/project';
import { getEnvWithDotnetTools, getCommandPath } from '../utils/execution';
import { getBuildChannel } from '../utils/output';
import { LogProcessor } from '../utils/logProcessor';

export async function buildCommand(arch?: string) {
    const buildChannel = getBuildChannel();
    const processor = new LogProcessor(buildChannel, true);

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

    const cosmosPath = getCommandPath('cosmos') || 'cosmos';

    const buildProcess = spawn(cosmosPath, buildArgs, {
        cwd: projectDir,
        env: { ...getEnvWithDotnetTools(), COLUMNS: '1000', CI: 'true' },
        shell: false
    });

    buildProcess.stdout?.on('data', (data) => processor.append(data));
    buildProcess.stderr?.on('data', (data) => processor.append(data));

    buildProcess.on('close', (code) => {
        processor.flush();
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
