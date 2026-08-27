const vscode = require('vscode');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');

const execAsync = promisify(exec);

function isCommandNotFound(error) {
  if (!error || typeof error !== 'object') return false;
  const text = `${error.message ?? ''}\n${error.stderr ?? ''}`;
  return error.code === 'ENOENT'
    || /command not found|not recognized as an internal or external command/i.test(text);
}

async function findGitRepository(resource) {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension) {
    throw new Error('VS Code Git extension is unavailable.');
  }

  const git = gitExtension.isActive
    ? gitExtension.exports
    : await gitExtension.activate();
  const api = git?.getAPI?.(1);
  if (!api) {
    throw new Error('VS Code Git API is unavailable.');
  }

  const repositories = api.repositories;
  const resourceUri = resource?.rootUri ?? resource?.uri ?? resource;
  const repository = resourceUri?.scheme && resourceUri?.fsPath
    ? api.getRepository(resourceUri)
    : undefined;
  if (repository) return repository;
  if (repositories.length === 0) return null;
  if (repositories.length === 1) return repositories[0];

  const selection = await vscode.window.showQuickPick(
    repositories.map(repository => ({
      label: repository.rootUri.fsPath,
      repository
    })),
    { placeHolder: 'Select a Git repository' }
  );
  return selection?.repository;
}

async function generateCommitMessage(resource) {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust this workspace before running aicommits.');
  }

  const repository = await findGitRepository(resource);
  if (repository === undefined) return;
  if (!repository?.rootUri) {
    throw new Error('No Git repository is open. Open a Git project first.');
  }

  const configuration = vscode.workspace.getConfiguration('aicommits');
  const command = configuration.get('command', 'aicommits');
  const output = configuration.get('output', 'stdout');

  if (typeof command !== 'string' || !command.trim()) {
    const error = new Error('aicommits.command 未配置，请在 VS Code 设置中配置。');
    error.openSettings = true;
    throw error;
  }
  if (output !== 'clipboard' && output !== 'stdout') {
    throw new Error('aicommits.output must be clipboard or stdout.');
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.SourceControl,
      title: 'Generating commit message…',
      cancellable: true
    },
    async (_progress, token) => {
      const controller = new AbortController();
      const cancellation = token.onCancellationRequested(() => controller.abort());
      let stdout;
      try {
        ({ stdout } = await execAsync(command, {
          cwd: repository.rootUri.fsPath,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          timeout: 5 * 60 * 1000,
          signal: controller.signal
        }));
      } catch (error) {
        if (token.isCancellationRequested) return;
        if (isCommandNotFound(error) && error && typeof error === 'object') {
          error.openSettings = true;
          error.message = '配置的命令不存在，请检查 VS Code 设置中的 aicommits.command。';
        }
        throw error;
      } finally {
        cancellation.dispose();
      }

      const message = output === 'stdout'
        ? stdout.trim()
        : (await vscode.env.clipboard.readText()).trim();
      if (!message) {
        throw new Error(
          output === 'stdout'
            ? 'The command did not print a commit message.'
            : 'The command did not provide a commit message in the clipboard.'
        );
      }

      repository.inputBox.value = message;
    }
  );
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'aicommits.generateCommitMessage',
      async resource => {
        try {
          await generateCommitMessage(resource);
        } catch (error) {
          const openSettings = error && typeof error === 'object' && error.openSettings === true;
          const message = error instanceof Error ? error.message : String(error);
          const action = openSettings
            ? await vscode.window.showErrorMessage(`aicommits failed: ${message}`, 'Open Settings')
            : await vscode.window.showErrorMessage(`aicommits failed: ${message}`);
          if (openSettings && action === 'Open Settings') {
            await vscode.commands.executeCommand(
              'workbench.action.openSettings',
              'aicommits.command'
            );
          }
        }
      }
    )
  );
}

module.exports = { activate };
