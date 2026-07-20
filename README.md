# Cosmos OS for VS Code

VS Code extension for [Cosmos gen3](https://github.com/valentinbreiz/nativeaot-patcher), the NativeAOT-based C# kernel framework. Create, build, run and debug a kernel without leaving the editor.

## Features

- New kernel project from the `cosmos new` template
- Build the kernel and run it in QEMU
- Debug with GDB (needs the C/C++ extension, `ms-vscode.cpptools`)
- Check and install the toolchain (.NET 10 SDK, Cosmos CLI, QEMU, GDB)
- Edit project properties
- Live kernel diagnostics: threads, GC and memory
- Clean build outputs

## Requirements

- [.NET SDK 10.0](https://dotnet.microsoft.com/download)+
- [Cosmos.Tools](https://www.nuget.org/packages/Cosmos.Tools) CLI, QEMU, and GDB (`gdb-multiarch` for ARM64)

Missing tools can be installed from the extension.

## Installation

Install from the Marketplace, then set up the toolchain:

```bash
dotnet tool install -g Cosmos.Tools
cosmos install
cosmos check
```

On Windows, run `CosmosSetup-<version>-windows.exe` from the [releases page](https://github.com/valentinbreiz/nativeaot-patcher/releases) instead.

## Documentation

[User Guide](https://valentinbreiz.github.io/nativeaot-patcher/articles/user/install.html) — installation, kernel startup, filesystem, network, graphics and debugging.

Also available for [Rider](https://github.com/valentinbreiz/CosmosRiderExtension).

## License

MIT
