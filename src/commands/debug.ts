import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import { getProjectInfo, parseProjectProperties } from '../utils/project';
import { getCosmosToolsPath, getGdbPath } from '../utils/cosmos';
import { getEnvWithDotnetTools, getCommandPath } from '../utils/execution';
import { getOutputChannel } from '../utils/output';
import { buildCommand } from './build';
import { LogProcessor } from '../utils/logProcessor';
import { parseMemoryMb } from '../utils/qemuOptions';

let activeCosmosProcess: ChildProcess | undefined;

export function onDebugSessionTerminated(session: vscode.DebugSession) {
    if (activeCosmosProcess && session.type === 'cppdbg' && session.name.startsWith('Debug ')) {
        if (!activeCosmosProcess.killed) {
            activeCosmosProcess.kill();
        }
        activeCosmosProcess = undefined;
        // Switch back to Cosmos view
        vscode.commands.executeCommand('workbench.view.extension.cosmos');
    }
}

export async function debugCommand(arch?: string) {
    const outputChannel = getOutputChannel();
    const processor = new LogProcessor(outputChannel);
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

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
    // Cosmos kernels build with RuntimeIdentifier=linux-<arch> on every host
    // OS — the ELF is the bare-metal binary, not a host executable.
    const binDir = path.join(projectDir, 'bin', 'Debug', 'net10.0', `linux-${arch}`);

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

    let elfPath: string | null = null;
    if (fs.existsSync(binDir)) {
        const elfFiles = fs.readdirSync(binDir).filter(f => f.endsWith('.elf'));
        if (elfFiles.length > 0) {
            elfPath = path.join(binDir, elfFiles[0]);
        }
    }

    if (isoFiles.length === 0) {
        const build = await vscode.window.showWarningMessage(
            `Build incomplete for ${arch} (missing ISO). Rebuild?`,
            'Build', 'Cancel'
        );
        if (build === 'Build') {
            await buildCommand(arch);
        }
        return;
    }

    if (!elfPath) {
        const build = await vscode.window.showWarningMessage(
            `Build incomplete for ${arch} (missing ELF for debugging). Rebuild?`,
            'Build', 'Cancel'
        );
        if (build === 'Build') {
            await buildCommand(arch);
        }
        return;
    }

    const isoPath = path.join(outputDir, isoFiles[0]);
    const gdbPort = 1234;
    const props = parseProjectProperties(projectInfo.csproj);

    const cosmosCmd = getCosmosToolsPath();
    if (!cosmosCmd) {
        vscode.window.showErrorMessage('cosmos CLI not installed. Install Cosmos.Tools as a dotnet global tool.');
        return;
    }

    // cosmos run --debug => QEMU with -s -S (gdbstub on 1234, frozen at startup).
    const cosmosArgs = ['run', '-a', arch, '--iso', isoPath, '--debug'];
    if (!props.enableGraphics) {
        cosmosArgs.push('--headless');
    }
    const memoryMb = parseMemoryMb(props.qemu.memory);
    if (memoryMb !== null) {
        cosmosArgs.push('-m', String(memoryMb));
    }

    outputChannel.show(true);
    outputChannel.clear();
    outputChannel.appendLine(`Debugging ${projectInfo.name} (${arch}) via cosmos run --debug`);
    outputChannel.appendLine(`GDB server port: ${gdbPort}`);
    outputChannel.appendLine(`ELF: ${elfPath}`);
    outputChannel.appendLine('');
    outputChannel.appendLine(`> ${cosmosCmd} ${cosmosArgs.join(' ')}`);
    outputChannel.appendLine('');

    // stdio: ['ignore', 'pipe', 'pipe']
    //   QEMU dies under Node's default `pipe` stdin when launched from a non-
    //   console GUI parent (VS Code) and paused via -S. Setting stdin to 'ignore'
    //   gives cosmos.exe — and the QEMU it spawns — NUL/dev/null instead of a
    //   piped fd. Stdout/stderr stay piped so we surface QEMU diagnostics in the
    //   output channel.
    const cosmosProcess = spawn(cosmosCmd, cosmosArgs, {
        cwd: projectDir,
        env: getEnvWithDotnetTools(),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    activeCosmosProcess = cosmosProcess;

    cosmosProcess.stdout?.on('data', (data) => processor.append(data));
    cosmosProcess.stderr?.on('data', (data) => processor.append(data));

    cosmosProcess.on('close', (code) => {
        processor.flush();
        outputChannel.appendLine('');
        outputChannel.appendLine(`cosmos run exited with code ${code}`);
        activeCosmosProcess = undefined;
        // Stop the cppdbg debug session when QEMU exits
        vscode.debug.stopDebugging();
    });

    cosmosProcess.on('error', (err) => {
        outputChannel.appendLine(`Error: ${err.message}`);
        vscode.window.showErrorMessage(`cosmos run error: ${err.message}`);
    });

    // Wait for QEMU's gdbstub to come up
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Resolve GDB path from cosmos check (returns absolute path), falling back
    // to PATH lookup — cppdbg on Windows rejects bare command names with
    // "Unable to determine path to debugger".
    let gdbPath = getGdbPath() || getCommandPath('gdb-multiarch');
    if (!gdbPath || (process.platform === 'win32' && !path.isAbsolute(gdbPath))) {
        vscode.window.showErrorMessage(
            'gdb-multiarch not found. Reinstall the Cosmos setup or run `cosmos install --auto --tools`.'
        );
        if (!activeCosmosProcess?.killed) {
            activeCosmosProcess?.kill();
        }
        activeCosmosProcess = undefined;
        return;
    }
    outputChannel.appendLine(`GDB: ${gdbPath}`);
    outputChannel.appendLine('');

    const debugConfig: vscode.DebugConfiguration = {
        name: `Debug ${arch} Kernel`,
        type: 'cppdbg',
        request: 'launch',
        program: elfPath,
        cwd: projectDir,
        MIMode: 'gdb',
        miDebuggerPath: gdbPath,
        miDebuggerServerAddress: `localhost:${gdbPort}`,
        stopAtEntry: false,
        setupCommands: [
            {
                // Must run before -target-select remote. Without this, cppdbg
                // on a Windows host assumes a Windows user-mode target and
                // issues qGetTIBAddr during target-select, which QEMU's bare-
                // metal gdbstub rejects with "Remote target doesn't support
                // qGetTIBAddr packet".
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
                description: 'Set disassembly flavor to Intel',
                text: '-gdb-set disassembly-flavor intel',
                ignoreFailures: true
            }
        ],
        // Surface MI traffic + gdb stderr in the Debug Console so cppdbg errors
        // aren't hidden behind MIDebugEngine's internal NullReferenceException.
        logging: {
            engineLogging: true,
            programOutput: true,
            exceptions: true,
            moduleLoad: false,
            trace: false,
            traceResponse: false
        },
        // Show registers in Variables panel
        showDisplayString: true
    };

    await vscode.debug.startDebugging(workspaceFolder, debugConfig);

    // Keep focus on Cosmos view
    vscode.commands.executeCommand('workbench.view.extension.cosmos');
}
