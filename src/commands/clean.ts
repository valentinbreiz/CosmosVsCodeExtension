import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getProjectInfo } from '../utils/project';

export async function cleanCommand() {
    const projectInfo = getProjectInfo();
    if (!projectInfo) {
        vscode.window.showErrorMessage('No Cosmos project found');
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        'Delete all build outputs?',
        'Yes', 'No'
    );

    if (confirm !== 'Yes') return;

    const projectDir = path.dirname(projectInfo.csproj);
    const dirsToClean = ['output-x64', 'output-arm64', 'bin', 'obj'];
    let cleaned = 0;

    for (const dir of dirsToClean) {
        const dirPath = path.join(projectDir, dir);
        if (fs.existsSync(dirPath)) {
            fs.rmSync(dirPath, { recursive: true, force: true });
            cleaned++;
        }
    }

    vscode.window.showInformationMessage(`Cleaned ${cleaned} directories`);
}
