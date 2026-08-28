# aicommits for VS Code

[简体中文](README.zh-CN.md)

Use [aicommits](https://github.com/jerryshell/aicommits) to generate a Git commit message from staged changes and fill it into VS Code's Git commit input box.

This extension can replace GitHub Copilot's `Generate Commit Message`: it runs the locally installed `aicommits` command and writes the generated result back to VS Code.

![VS Code Source Control panel](docs/aicommits-vscode.png)

## Prerequisites

Install and configure [aicommits](https://github.com/jerryshell/aicommits) first:

```bash
git clone https://github.com/jerryshell/aicommits.git
cd aicommits
bun install
bun run build
bun link
aicommits setup
```

Verify that the command is available:

```bash
aicommits --help
```

## Install the extension

From this repository, run:

```bash
npm install
make install
```

`make install` requires the VS Code `code` command to be available. Alternatively, run `make package` and install the generated `.vsix` file with [VS Code's extension installation workflow](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace).

## Usage

1. Open a Git repository in VS Code and stage the changes you want to commit.
2. Click the `aicommits` button in the Source Control panel, or run **aicommits: Generate Commit Message** from the Command Palette.
3. The generated commit message is filled into the commit input box. Review it and commit.

If the extension cannot find the `aicommits` command after installation or configuration changes, restart VS Code.

## Configuration

The default configuration is:

```json
{
  "aicommits.command": "aicommits",
  "aicommits.output": "stdout"
}
```

Change `aicommits.command` and `aicommits.output` in VS Code Settings to use a custom command or read the result from the system clipboard.

The workspace must be trusted. The extension also depends on VS Code's built-in Git extension.

## How it works

1. `package.json` registers the `aicommits.generateCommitMessage` command and exposes it in the Command Palette and the Git Source Control panel.
2. The extension uses the built-in `vscode.git` API to find the current Git repository. If multiple repositories are open, it asks you to choose one.
3. It reads `aicommits.command` from the settings and runs the command in the repository root. By default, it reads the generated message from standard output; it can also read from the system clipboard.
4. After receiving a non-empty result, it writes the message to the repository's commit input box. Cancellation, timeouts, and command failures are shown as error notifications.

Related VS Code documentation:

- [Commands API](https://code.visualstudio.com/api/extension-guides/command)
- [Activation Events](https://code.visualstudio.com/api/references/activation-events)
- [Git extension API](https://github.com/microsoft/vscode/blob/main/extensions/git/README.md)

## Development

```bash
npm test
make package
```
