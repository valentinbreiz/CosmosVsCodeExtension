import * as vscode from 'vscode';

let buildChannel: vscode.OutputChannel;
let outputChannel: vscode.OutputChannel;

export function getBuildChannel(): vscode.OutputChannel {
    if (!buildChannel) {
        buildChannel = vscode.window.createOutputChannel('Cosmos OS - Build');
    }
    return buildChannel;
}

export function getOutputChannel(): vscode.OutputChannel {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('Cosmos OS - Output');
    }
    return outputChannel;
}
