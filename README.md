# Cosmos OS gen3 Development for VS Code

VS Code extension for creating kernel project with Cosmos OS gen3.

> ⚠️ This extension currently supports **x64** targets **only**. 

## Getting Started

1. Install the extension
2. Click the Cosmos icon in the Activity Bar
3. Click "Create Kernel Project"
4. Follow the wizard to set up your kernel

## Requirements

- [.NET 10 SDK](https://dotnet.microsoft.com/download)
- [cosmos-tools](https://www.nuget.org/packages/Cosmos.Tools) CLI
- QEMU (for running/debugging)
- GDB (for debugging)

The extension will prompt to install missing tools automatically.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `cosmos.defaultArchitecture` | `x64` | Default target architecture |
| `cosmos.qemuMemory` | `512M` | QEMU memory allocation |

## Installation

### From VSIX
```bash
code --install-extension cosmos-vscode-1.0.0.vsix
```

## License

MIT
