import * as vscode from 'vscode';

export class LoadingViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'cosmos.loading';
    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: false,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
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
    }
}
