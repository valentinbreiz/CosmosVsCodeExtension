import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn } from 'child_process';
import { TestKernel, locateTestRunnerDll, locateTestRunnerProject } from './discovery';
import { defaultTimeoutSeconds } from './timeouts';
import { parseJUnitXml, JUnitCase } from './junitParser';
import { getEnvWithDotnetTools, getCommandPath } from '../utils/execution';

export interface RunOutcome {
    /** true = engine returned 0; false = non-zero, killed, or no XML */
    success: boolean;
    /** the JUnit cases parsed from the engine's XML output, empty on hard failure */
    cases: JUnitCase[];
    /** human-readable error if no XML was produced or the suite errored out */
    error?: string;
}

function stripAnsi(s: string): string {
    return s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Test run terminals require \r\n line endings. Normalize the data so
 * pre-existing \r\n sequences aren't doubled into \r\r\n.
 */
function toTerminalText(s: string): string {
    return stripAnsi(s).replace(/\r?\n/g, '\r\n');
}

async function ensureTestRunnerDll(out: vscode.TestRun): Promise<string | undefined> {
    const existing = locateTestRunnerDll();
    if (existing) {
        return existing;
    }

    const csproj = locateTestRunnerProject();
    if (!csproj) {
        out.appendOutput('error: could not find Cosmos.TestRunner.Engine.csproj\r\n');
        return undefined;
    }

    out.appendOutput(`Building Cosmos.TestRunner.Engine (one-time)...\r\n`);
    const dotnet = getCommandPath('dotnet') || 'dotnet';
    const result = await new Promise<number | null>((resolve) => {
        const p = spawn(dotnet, ['build', csproj, '-c', 'Debug'], {
            cwd: path.dirname(csproj),
            env: getEnvWithDotnetTools(),
            shell: false
        });
        p.stdout?.on('data', d => out.appendOutput(toTerminalText(d.toString())));
        p.stderr?.on('data', d => out.appendOutput(toTerminalText(d.toString())));
        p.on('close', code => resolve(code));
        p.on('error', () => resolve(-1));
    });

    if (result !== 0) {
        out.appendOutput(`dotnet build failed with exit code ${result}\r\n`);
        return undefined;
    }
    return locateTestRunnerDll();
}

export interface RunOptions {
    kernel: TestKernel;
    arch: string;
    /** ci = headless, dev = visual QEMU window */
    mode: 'ci' | 'dev';
    timeoutSeconds?: number;
    token: vscode.CancellationToken;
    out: vscode.TestRun;
}

export async function runTestKernel(opts: RunOptions): Promise<RunOutcome> {
    const { kernel, arch, mode, token, out } = opts;
    const timeout = opts.timeoutSeconds ?? defaultTimeoutSeconds(kernel.suiteName, arch);

    const enginePath = await ensureTestRunnerDll(out);
    if (!enginePath) {
        return { success: false, cases: [], error: 'Test runner engine not available' };
    }

    const tmpXml = path.join(
        os.tmpdir(),
        `cosmos-test-${kernel.suiteName}-${arch}-${process.pid}-${Date.now()}.xml`
    );

    const dotnet = getCommandPath('dotnet') || 'dotnet';
    const args = [
        enginePath,
        kernel.projectDir,
        arch,
        String(timeout),
        tmpXml,
        mode
    ];

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || kernel.projectDir;

    out.appendOutput(`> dotnet ${args.join(' ')}\r\n`);
    out.appendOutput(`(timeout ${timeout}s, mode ${mode})\r\n\r\n`);

    const proc = spawn(dotnet, args, {
        cwd,
        env: getEnvWithDotnetTools(),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    const cancelHandler = token.onCancellationRequested(() => {
        if (!proc.killed) {
            proc.kill();
        }
    });

    proc.stdout?.on('data', d => out.appendOutput(toTerminalText(d.toString())));
    proc.stderr?.on('data', d => out.appendOutput(toTerminalText(d.toString())));

    const exitCode = await new Promise<number | null>((resolve) => {
        proc.on('close', resolve);
        proc.on('error', () => resolve(-1));
    });
    cancelHandler.dispose();

    if (token.isCancellationRequested) {
        out.appendOutput('\r\nrun cancelled\r\n');
        try { fs.unlinkSync(tmpXml); } catch { }
        return { success: false, cases: [], error: 'cancelled' };
    }

    const parsed = parseJUnitXml(tmpXml);
    try { fs.unlinkSync(tmpXml); } catch { }

    if (!parsed) {
        return {
            success: false,
            cases: [],
            error: `engine exited with code ${exitCode} and produced no XML`
        };
    }

    if (parsed.timedOut) {
        out.appendOutput('\r\nsuite timed out\r\n');
    }

    return {
        success: exitCode === 0,
        cases: parsed.cases,
        error: parsed.timedOut ? 'suite timed out' : undefined
    };
}
