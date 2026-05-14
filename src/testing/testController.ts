import * as vscode from 'vscode';
import { TestKernel, findTestKernels } from './discovery';
import { runTestKernel } from './testRunner';
import { debugTestKernel } from './debugTestKernel';

const ARCHES = ['x64', 'arm64'] as const;
type Arch = typeof ARCHES[number];

interface SuiteEntry {
    kernel: TestKernel;
    item: vscode.TestItem;
}

export class CosmosTestController implements vscode.Disposable {
    private readonly controller: vscode.TestController;
    private readonly suites = new Map<string, SuiteEntry>();
    private readonly watchers: vscode.FileSystemWatcher[] = [];
    private readonly disposables: vscode.Disposable[] = [];

    constructor() {
        this.controller = vscode.tests.createTestController(
            'cosmosKernelTests',
            'Cosmos Kernel Tests'
        );

        for (const arch of ARCHES) {
            this.controller.createRunProfile(
                `Run ${arch}`,
                vscode.TestRunProfileKind.Run,
                (req, tok) => this.executeRun(req, tok, arch),
                arch === 'x64' // x64 as default
            );
            this.controller.createRunProfile(
                `Debug ${arch}`,
                vscode.TestRunProfileKind.Debug,
                (req, tok) => this.executeDebug(req, tok, arch),
                false
            );
        }

        this.controller.refreshHandler = async () => this.refresh();

        this.refresh();
        this.watchWorkspace();
    }

    private watchWorkspace(): void {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders) {
            return;
        }
        for (const folder of folders) {
            const pattern = new vscode.RelativePattern(folder, 'tests/Kernels/Cosmos.Kernel.Tests.*/*.csproj');
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);
            watcher.onDidCreate(() => this.refresh());
            watcher.onDidDelete(() => this.refresh());
            this.watchers.push(watcher);
        }
        this.disposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh())
        );
    }

    private refresh(): void {
        const found = findTestKernels();
        const seen = new Set<string>();

        for (const kernel of found) {
            seen.add(kernel.suiteName);
            let entry = this.suites.get(kernel.suiteName);
            if (!entry) {
                const item = this.controller.createTestItem(
                    kernel.suiteName,
                    kernel.suiteName,
                    vscode.Uri.file(kernel.csprojPath)
                );
                item.canResolveChildren = false;
                this.controller.items.add(item);
                entry = { kernel, item };
                this.suites.set(kernel.suiteName, entry);
            } else {
                entry.kernel = kernel;
            }
        }

        for (const name of [...this.suites.keys()]) {
            if (!seen.has(name)) {
                this.controller.items.delete(name);
                this.suites.delete(name);
            }
        }
    }

    private collectSuites(req: vscode.TestRunRequest): SuiteEntry[] {
        const result: SuiteEntry[] = [];
        const include = req.include?.length ? req.include : [...this.controller.items].map(([, it]) => it);
        const exclude = new Set(req.exclude?.map(i => i.id));

        for (const item of include) {
            if (exclude.has(item.id)) {
                continue;
            }
            // climb to suite root
            let root = item;
            while (root.parent) {
                root = root.parent;
            }
            const entry = this.suites.get(root.id);
            if (entry && !result.includes(entry)) {
                result.push(entry);
            }
        }
        return result;
    }

    private async executeRun(
        req: vscode.TestRunRequest,
        token: vscode.CancellationToken,
        arch: Arch
    ): Promise<void> {
        const targets = this.collectSuites(req);
        if (targets.length === 0) {
            return;
        }

        const run = this.controller.createTestRun(req, `Cosmos ${arch}`, false);
        const mode = vscode.workspace.getConfiguration('cosmos').get<'ci' | 'dev'>('testMode', 'ci');

        try {
            for (const target of targets) {
                if (token.isCancellationRequested) {
                    run.skipped(target.item);
                    continue;
                }
                run.started(target.item);
                run.appendOutput(`\r\n=== ${target.kernel.suiteName} (${arch}) ===\r\n`);

                const start = Date.now();
                const outcome = await runTestKernel({
                    kernel: target.kernel,
                    arch,
                    mode,
                    token,
                    out: run
                });
                const elapsed = Date.now() - start;

                this.applyOutcome(run, target, outcome, elapsed);
            }
        } finally {
            run.end();
        }
    }

    private applyOutcome(
        run: vscode.TestRun,
        target: SuiteEntry,
        outcome: { success: boolean; cases: { name: string; status: 'passed' | 'failed' | 'skipped'; message?: string; timeSeconds: number }[]; error?: string },
        elapsedMs: number
    ): void {
        if (outcome.cases.length === 0) {
            const msg = new vscode.TestMessage(outcome.error ?? 'Test run produced no results');
            run.failed(target.item, msg, elapsedMs);
            return;
        }

        // Populate per-method TestItems (Level 3) under the suite.
        const childIds = new Set<string>();
        for (const c of outcome.cases) {
            const childId = `${target.item.id}::${c.name}`;
            let child = target.item.children.get(childId);
            if (!child) {
                child = this.controller.createTestItem(childId, c.name, target.item.uri);
                target.item.children.add(child);
            }
            childIds.add(childId);

            const durMs = c.timeSeconds * 1000;
            if (c.status === 'passed') {
                run.passed(child, durMs);
            } else if (c.status === 'skipped') {
                run.skipped(child);
            } else {
                run.failed(child, new vscode.TestMessage(c.message ?? 'failed'), durMs);
            }
        }

        // Drop stale children from previous runs that no longer appear.
        const toRemove: string[] = [];
        target.item.children.forEach(c => {
            if (!childIds.has(c.id)) {
                toRemove.push(c.id);
            }
        });
        for (const id of toRemove) {
            target.item.children.delete(id);
        }

        const failed = outcome.cases.filter(c => c.status === 'failed').length;
        if (failed > 0 || !outcome.success) {
            const msg = new vscode.TestMessage(
                outcome.error ?? `${failed} test(s) failed`
            );
            run.failed(target.item, msg, elapsedMs);
        } else {
            run.passed(target.item, elapsedMs);
        }
    }

    private async executeDebug(
        req: vscode.TestRunRequest,
        token: vscode.CancellationToken,
        arch: Arch
    ): Promise<void> {
        const targets = this.collectSuites(req);
        if (targets.length === 0) {
            return;
        }
        if (targets.length > 1) {
            vscode.window.showWarningMessage(
                `Debugging only the first selected suite: ${targets[0].kernel.suiteName}.`
            );
        }
        const target = targets[0];

        const run = this.controller.createTestRun(req, `Cosmos debug ${arch}`, false);
        try {
            run.started(target.item);
            run.appendOutput(`\r\nLaunching ${target.kernel.suiteName} (${arch}) under gdb...\r\n`);
            const ok = await debugTestKernel(target.kernel.projectDir, arch);
            if (ok) {
                run.appendOutput('Debug session attached. End the session to finish the run.\r\n');
                // Wait for either the cosmos-gdb session to end or cancellation.
                await new Promise<void>(resolve => {
                    const sub = vscode.debug.onDidTerminateDebugSession(session => {
                        if (session.name.startsWith(`Cosmos Test Debug ${target.kernel.suiteName}`)) {
                            sub.dispose();
                            cancelSub.dispose();
                            resolve();
                        }
                    });
                    const cancelSub = token.onCancellationRequested(() => {
                        sub.dispose();
                        cancelSub.dispose();
                        resolve();
                    });
                });
                run.skipped(target.item);
            } else {
                run.failed(target.item, new vscode.TestMessage('Failed to start debug session'));
            }
        } finally {
            run.end();
        }
    }

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
        for (const w of this.watchers) {
            w.dispose();
        }
        this.controller.dispose();
    }
}
