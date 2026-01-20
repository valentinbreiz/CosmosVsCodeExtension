# Cosmos OS gen3 Development for VS Code

VS Code extension for creating kernel projects with Cosmos OS gen3.

## Getting Started

1. Install the extension
2. Click the Cosmos icon in the Activity Bar
3. Click "Create Kernel Project"
4. Follow the wizard to set up your kernel

## Requirements

- [.NET 10 SDK](https://dotnet.microsoft.com/download)
- [cosmos](https://www.nuget.org/packages/Cosmos.Tools) CLI
- QEMU (for running/debugging)
- GDB (for debugging)

The extension will prompt to install missing tools automatically.

## Installation

```bash
dotnet tool install -g Cosmos.Tools
cosmos check
cosmos install
```

## License

MIT
