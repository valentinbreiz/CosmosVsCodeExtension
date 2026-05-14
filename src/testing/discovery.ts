import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface TestKernel {
    suiteName: string;
    projectDir: string;
    csprojPath: string;
}

const KERNEL_NAME_PREFIX = 'Cosmos.Kernel.Tests.';

export function findTestKernels(): TestKernel[] {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) {
        return [];
    }

    const results: TestKernel[] = [];
    for (const folder of folders) {
        const root = folder.uri.fsPath;
        const kernelsRoot = path.join(root, 'tests', 'Kernels');
        if (!fs.existsSync(kernelsRoot)) {
            continue;
        }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(kernelsRoot, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            if (!entry.name.startsWith(KERNEL_NAME_PREFIX)) {
                continue;
            }

            const projectDir = path.join(kernelsRoot, entry.name);
            const csprojPath = path.join(projectDir, `${entry.name}.csproj`);
            if (!fs.existsSync(csprojPath)) {
                continue;
            }

            results.push({
                suiteName: entry.name.substring(KERNEL_NAME_PREFIX.length),
                projectDir,
                csprojPath
            });
        }
    }

    results.sort((a, b) => a.suiteName.localeCompare(b.suiteName));
    return results;
}

export function locateTestRunnerDll(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) {
        return undefined;
    }
    for (const folder of folders) {
        const candidate = path.join(
            folder.uri.fsPath,
            'artifacts', 'bin', 'Cosmos.TestRunner.Engine', 'debug',
            'Cosmos.TestRunner.Engine.dll'
        );
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

export function locateTestRunnerProject(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) {
        return undefined;
    }
    for (const folder of folders) {
        const candidate = path.join(
            folder.uri.fsPath,
            'tests', 'Cosmos.TestRunner.Engine', 'Cosmos.TestRunner.Engine.csproj'
        );
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}
