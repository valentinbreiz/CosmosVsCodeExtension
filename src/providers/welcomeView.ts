import * as vscode from 'vscode';

export class WelcomeViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'cosmos.welcome';
    private _view?: vscode.WebviewView;
    private _isCosmosProject: boolean;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        isCosmosProject: boolean
    ) {
        this._isCosmosProject = isCosmosProject;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Handle messages from the webview
        webviewView.webview.onDidReceiveMessage(message => {
            switch (message.command) {
                case 'newProject':
                    vscode.commands.executeCommand('cosmos.newProject');
                    break;
                case 'openFolder':
                    vscode.commands.executeCommand('vscode.openFolder');
                    break;
            }
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        if (this._isCosmosProject) {
            // Show loading gif for Cosmos projects
            const gifUri = webview.asWebviewUri(
                vscode.Uri.joinPath(this._extensionUri, 'media', 'welcome.gif')
            );

            return `<!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Loading</title>
                    <style>
                        html, body {
                            margin: 0;
                            padding: 0;
                            height: 100%;
                            overflow: hidden;
                        }
                        body {
                            display: flex;
                            flex-direction: column;
                            align-items: center;
                            justify-content: center;
                            background-color: transparent;
                            color: var(--vscode-foreground);
                            font-family: var(--vscode-font-family);
                        }
                        .loading-gif {
                            max-width: 120px;
                            max-height: 120px;
                            object-fit: contain;
                            margin-bottom: 12px;
                        }
                        .loading-text {
                            color: var(--vscode-descriptionForeground);
                            font-size: 12px;
                        }
                    </style>
                </head>
                <body>
                    <img src="${gifUri}" alt="Loading" class="loading-gif">
                    <div class="loading-text">Loading Cosmos...</div>
                </body>
                </html>`;
        } else {
            // Show welcome screen with PNG and buttons for non-Cosmos projects
            const logoUri = webview.asWebviewUri(
                vscode.Uri.joinPath(this._extensionUri, 'media', 'cosmos-logo.png')
            );

            return `<!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Welcome</title>
                    <style>
                        * {
                            box-sizing: border-box;
                        }
                        html, body {
                            margin: 0;
                            padding: 0;
                            height: 100%;
                            overflow: hidden;
                        }
                        body {
                            padding: 16px;
                            display: flex;
                            flex-direction: column;
                            align-items: center;
                            justify-content: center;
                            background-color: transparent;
                            color: var(--vscode-foreground);
                            font-family: var(--vscode-font-family);
                            font-size: var(--vscode-font-size);
                        }
                        .logo {
                            max-width: 120px;
                            max-height: 120px;
                            object-fit: contain;
                            margin-bottom: 16px;
                        }
                        .title {
                            font-size: 14px;
                            font-weight: 600;
                            margin-bottom: 8px;
                            color: var(--vscode-foreground);
                        }
                        .description {
                            font-size: 12px;
                            color: var(--vscode-descriptionForeground);
                            margin-bottom: 16px;
                            line-height: 1.4;
                            text-align: center;
                        }
                        .button {
                            width: 100%;
                            max-width: 200px;
                            padding: 8px 16px;
                            margin-bottom: 8px;
                            background-color: var(--vscode-button-background);
                            color: var(--vscode-button-foreground);
                            border: none;
                            border-radius: 2px;
                            cursor: pointer;
                            font-size: 13px;
                            font-family: var(--vscode-font-family);
                            transition: background-color 0.1s ease;
                        }
                        .button:hover {
                            background-color: var(--vscode-button-hoverBackground);
                        }
                        .button.secondary {
                            background-color: var(--vscode-button-secondaryBackground);
                            color: var(--vscode-button-secondaryForeground);
                        }
                        .button.secondary:hover {
                            background-color: var(--vscode-button-secondaryHoverBackground);
                        }
                        .separator {
                            font-size: 11px;
                            color: var(--vscode-descriptionForeground);
                            margin: 8px 0;
                        }
                    </style>
                </head>
                <body>
                    <img src="${logoUri}" alt="Cosmos OS" class="logo">
                    <div class="description">Create your first bare-metal C# kernel.</div>
                    <button class="button" onclick="newProject()">Create Kernel Project</button>
                    <div class="separator">or</div>
                    <button class="button secondary" onclick="openFolder()">Open Folder</button>

                    <script>
                        const vscode = acquireVsCodeApi();

                        function newProject() {
                            vscode.postMessage({ command: 'newProject' });
                        }

                        function openFolder() {
                            vscode.postMessage({ command: 'openFolder' });
                        }
                    </script>
                </body>
                </html>`;
        }
    }
}
