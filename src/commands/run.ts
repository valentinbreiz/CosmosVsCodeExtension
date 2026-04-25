import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { getProjectInfo, parseProjectProperties } from '../utils/project';
import { getCosmosToolsPath, getPlatformInfo } from '../utils/cosmos';
import { getEnvWithDotnetTools } from '../utils/execution';
import { getOutputChannel } from '../utils/output';
import { buildCommand } from './build';
import { runDebugAdapterFactory } from '../extension';
import { LogProcessor } from '../utils/logProcessor';
import { parseMemoryMb } from '../utils/qemuOptions';

export async function runCommand(arch?: string) {
    const outputChannel = getOutputChannel();
    const processor = new LogProcessor(outputChannel);

    const projectInfo = getProjectInfo();
    if (!projectInfo) {
        vscode.window.showErrorMessage('No Cosmos project found');
        return;
    }

    if (!arch) {
        arch = projectInfo.arch;
    }

    const projectDir = path.dirname(projectInfo.csproj);
    const outputDir = path.join(projectDir, `output-${arch}`);

    if (!fs.existsSync(outputDir)) {
        const build = await vscode.window.showWarningMessage(
            `No build found for ${arch}. Build first?`,
            'Build', 'Cancel'
        );
        if (build === 'Build') {
            await buildCommand(arch);
        }
        return;
    }

    const isoFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.iso'));
    if (isoFiles.length === 0) {
        vscode.window.showErrorMessage('No ISO file found. Please build the project first.');
        return;
    }

    const isoPath = path.join(outputDir, isoFiles[0]);
    const props = parseProjectProperties(projectInfo.csproj);

    const cosmosCmd = getCosmosToolsPath();
    if (!cosmosCmd) {
        vscode.window.showErrorMessage('cosmos CLI not installed. Install Cosmos.Tools as a dotnet global tool.');
        return;
    }

    const cosmosArgs = ['run', '-a', arch, '--iso', isoPath];
    if (!props.enableGraphics) {
        cosmosArgs.push('--headless');
    }
    const memoryMb = parseMemoryMb(props.qemu.memory);
    if (memoryMb !== null) {
        cosmosArgs.push('-m', String(memoryMb));
    }

    outputChannel.show(true);
    outputChannel.clear();
    outputChannel.appendLine(`Running ${projectInfo.name} (${arch}) via cosmos run`);
    outputChannel.appendLine(`Platform: ${getPlatformInfo().platformName}`);
    outputChannel.appendLine('');
    outputChannel.appendLine(`> ${cosmosCmd} ${cosmosArgs.join(' ')}`);
    outputChannel.appendLine('');

    // stdio: ['ignore', 'pipe', 'pipe']
    //   QEMU dies under Node's default `pipe` stdin when launched as a child of
    //   a non-console GUI process (VS Code) on Windows. Setting stdin to 'ignore'
    //   gives cosmos.exe — and the QEMU it spawns — NUL/dev/null instead of a
    //   piped fd. Stdout/stderr stay piped so we stream cosmos+QEMU output into
    //   the output channel.
    const cosmosProcess = spawn(cosmosCmd, cosmosArgs, {
        cwd: projectDir,
        env: getEnvWithDotnetTools(),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    cosmosProcess.stdout?.on('data', (data) => processor.append(data));
    cosmosProcess.stderr?.on('data', (data) => processor.append(data));

    cosmosProcess.on('close', (code) => {
        processor.flush();
        outputChannel.appendLine('');
        outputChannel.appendLine(`cosmos run exited with code ${code}`);
    });

    cosmosProcess.on('error', (err) => {
        outputChannel.appendLine(`Error: ${err.message}`);
        vscode.window.showErrorMessage(`cosmos run error: ${err.message}`);
    });

    // Use our custom debug adapter to provide the stop button
    runDebugAdapterFactory.setProcess(cosmosProcess);

    await vscode.debug.startDebugging(undefined, {
        name: `Run ${projectInfo.name}`,
        type: 'cosmos-run',
        request: 'launch',
        internalConsoleOptions: 'neverOpen'
    });

    // Keep focus on Cosmos view
    vscode.commands.executeCommand('workbench.view.extension.cosmos');
}
