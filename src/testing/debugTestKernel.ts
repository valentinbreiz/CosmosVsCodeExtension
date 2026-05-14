import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { getCosmosToolsPath, getGdbPath } from '../utils/cosmos';
import { getEnvWithDotnetTools, getCommandPath } from '../utils/execution';
import { getOutputChannel } from '../utils/output';
import { LogProcessor } from '../utils/logProcessor';
import { parseProjectProperties } from '../utils/project';

const activeProcesses = new Map<string, ChildProcess>();

export function onTestDebugSessionTerminated(session: vscode.DebugSession): void {
    if (session.type !== 'cppdbg' || !session.name.startsWith('Cosmos Test Debug ')) {
        return;
    }
    const proc = activeProcesses.get(session.name);
    if (proc && !proc.killed) {
        proc.kill();
    }
    activeProcesses.delete(session.name);
}

/**
 * Boots a test kernel under QEMU's gdbstub and attaches cppdbg. Mirrors the
 * existing kernel debug flow but takes the project directory explicitly so it
 * can target a kernel that isn't the workspace's primary project.
 */
export async function debugTestKernel(projectDir: string, arch: string): Promise<boolean> {
    const outputChannel = getOutputChannel();
    const processor = new LogProcessor(outputChannel);
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open');
        return false;
    }

    const csprojFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.csproj'));
    if (csprojFiles.length === 0) {
        vscode.window.showErrorMessage(`No .csproj in ${projectDir}`);
        return false;
    }
    const csproj = path.join(projectDir, csprojFiles[0]);
    const kernelName = path.basename(csproj, '.csproj');

    const outputDir = path.join(projectDir, `output-${arch}`);
    const binDir = path.join(projectDir, 'bin', 'Debug', 'net10.0', `linux-${arch}`);

    if (!fs.existsSync(outputDir)) {
        vscode.window.showErrorMessage(
            `No build for ${arch} at ${outputDir}. Run the test once to build, then debug.`
        );
        return false;
    }
    const isoFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.iso'));
    if (isoFiles.length === 0) {
        vscode.window.showErrorMessage(`No ISO found in ${outputDir}.`);
        return false;
    }
    const isoPath = path.join(outputDir, isoFiles[0]);

    let elfPath: string | undefined;
    if (fs.existsSync(binDir)) {
        const elfFiles = fs.readdirSync(binDir).filter(f => f.endsWith('.elf'));
        if (elfFiles.length > 0) {
            elfPath = path.join(binDir, elfFiles[0]);
        }
    }
    if (!elfPath) {
        vscode.window.showErrorMessage(
            `No ELF found in ${binDir}. Rebuild the test kernel before debugging.`
        );
        return false;
    }

    const cosmosCmd = getCosmosToolsPath();
    if (!cosmosCmd) {
        vscode.window.showErrorMessage('cosmos CLI not installed. Install Cosmos.Tools as a dotnet global tool.');
        return false;
    }

    const props = parseProjectProperties(csproj);
    const cosmosArgs = ['run', '-a', arch, '--iso', isoPath, '--debug'];
    if (!props.enableGraphics) {
        cosmosArgs.push('--headless');
    }

    outputChannel.show(true);
    outputChannel.appendLine('');
    outputChannel.appendLine(`Debugging test kernel ${kernelName} (${arch})`);
    outputChannel.appendLine(`ISO: ${isoPath}`);
    outputChannel.appendLine(`ELF: ${elfPath}`);
    outputChannel.appendLine(`> ${cosmosCmd} ${cosmosArgs.join(' ')}`);
    outputChannel.appendLine('');

    const cosmosProcess = spawn(cosmosCmd, cosmosArgs, {
        cwd: projectDir,
        env: getEnvWithDotnetTools(),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    const sessionName = `Cosmos Test Debug ${kernelName} ${arch}`;
    activeProcesses.set(sessionName, cosmosProcess);

    cosmosProcess.stdout?.on('data', d => processor.append(d));
    cosmosProcess.stderr?.on('data', d => processor.append(d));
    cosmosProcess.on('close', code => {
        processor.flush();
        outputChannel.appendLine(`cosmos run exited with code ${code}`);
        if (activeProcesses.get(sessionName) === cosmosProcess) {
            activeProcesses.delete(sessionName);
        }
    });
    cosmosProcess.on('error', err => {
        outputChannel.appendLine(`Error: ${err.message}`);
    });

    // Wait for QEMU's gdbstub to come up
    await new Promise(resolve => setTimeout(resolve, 1500));

    const gdbPath = getGdbPath() || getCommandPath('gdb-multiarch');
    if (!gdbPath) {
        vscode.window.showErrorMessage(
            'gdb-multiarch not found. Reinstall the Cosmos setup or run `cosmos install --auto --tools`.'
        );
        if (!cosmosProcess.killed) {
            cosmosProcess.kill();
        }
        activeProcesses.delete(sessionName);
        return false;
    }

    const debugConfig: vscode.DebugConfiguration = {
        name: sessionName,
        type: 'cppdbg',
        request: 'launch',
        program: elfPath,
        cwd: projectDir,
        MIMode: 'gdb',
        miDebuggerPath: gdbPath,
        miDebuggerServerAddress: 'localhost:1234',
        stopAtEntry: false,
        setupCommands: [
            {
                description: 'Disable OS ABI probing (bare-metal kernel)',
                text: '-gdb-set osabi none',
                ignoreFailures: false
            },
            {
                description: 'Enable pretty-printing for gdb',
                text: '-enable-pretty-printing',
                ignoreFailures: true
            },
            {
                description: arch === 'arm64' ? 'Set architecture aarch64' : 'Set disassembly flavor to Intel',
                text: arch === 'arm64' ? 'set architecture aarch64' : '-gdb-set disassembly-flavor intel',
                ignoreFailures: arch !== 'arm64'
            }
        ]
    };

    return vscode.debug.startDebugging(workspaceFolder, debugConfig);
}
