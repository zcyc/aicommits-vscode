const vscode = require('vscode');
const { spawn } = require('node:child_process');

const activeRuns = new Map();
const commandTimeout = 5 * 60 * 1000;
let nextRunId = 0;

function isCommandNotFound(error) {
  if (!error || typeof error !== 'object') return false;
  const stderr = `${error.stderr ?? ''}`;
  return error.code === 'ENOENT'
    || error.code === 127
    || (process.platform === 'win32'
      && error.code === 1
      && /^\s*['"].+['"] is not recognized as an internal or external command,\s*[\r\n]+operable program or batch file\.\s*$/i.test(stderr));
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn(
      'taskkill',
      ['/pid', String(child.pid), '/T', '/F'],
      { stdio: 'ignore', windowsHide: true }
    );
    killer.on('error', () => child.kill());
    killer.on('close', code => { if (code !== 0) child.kill(); });
    return;
  }

  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

function executeCommand(command, options, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      ...options,
      shell: true,
      detached: process.platform !== 'win32'
    });
    const maxBuffer = options.maxBuffer ?? 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let maxBufferStream;
    let killed = false;
    let timedOut = false;
    let settled = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killed = true;
      terminateProcessTree(child);
    }, commandTimeout);
    const terminate = () => {
      killed = true;
      terminateProcessTree(child);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', terminate);
    };
    const finish = callback => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const collect = (stream, chunk) => {
      const bytes = Buffer.byteLength(chunk);
      if (stream === 'stdout') {
        stdout += chunk;
        stdoutBytes += bytes;
        if (stdoutBytes > maxBuffer) maxBufferStream = stream;
      } else {
        stderr += chunk;
        stderrBytes += bytes;
        if (stderrBytes > maxBuffer) maxBufferStream = stream;
      }
      if (maxBufferStream) terminate();
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    child.on('error', error => finish(() => {
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    }));
    child.on('close', (code, signalName) => finish(() => {
      if (maxBufferStream) {
        const error = new Error(`${maxBufferStream} maxBuffer length exceeded`);
        error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      if (timedOut) {
        const error = new Error(`Command failed: ${command}\n`);
        error.code = null;
        error.signal = 'SIGTERM';
        error.killed = true;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`Command failed: ${command}\n${stderr}`);
      error.code = code;
      error.signal = signalName;
      error.killed = killed;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    }));

    if (signal.aborted) {
      terminate();
    } else {
      signal.addEventListener('abort', terminate, { once: true });
    }
  });
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

  const run = { controller: new AbortController(), id: ++nextRunId };
  let repositoryKey;

  try {
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

    repositoryKey = repository.rootUri.fsPath;
    const currentRun = activeRuns.get(repositoryKey);
    if (currentRun?.id > run.id) return;
    currentRun?.controller.abort();
    activeRuns.set(repositoryKey, run);
    const isCurrentRun = () => activeRuns.get(repositoryKey) === run;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.SourceControl,
        title: 'Generating commit message…',
        cancellable: true
      },
      async (_progress, token) => {
        if (!isCurrentRun() || token.isCancellationRequested) return;
        const cancellation = token.onCancellationRequested(() => run.controller.abort());
        let stdout;
        try {
          ({ stdout } = await executeCommand(command, {
            cwd: repository.rootUri.fsPath,
            maxBuffer: 1024 * 1024,
            windowsHide: true
          }, run.controller.signal));
        } catch (error) {
          if (token.isCancellationRequested || !isCurrentRun()) return;
          if (isCommandNotFound(error) && error && typeof error === 'object') {
            error.openSettings = true;
            error.message = '配置的命令不存在，请检查 VS Code 设置中的 aicommits.command。';
          }
          throw error;
        } finally {
          cancellation.dispose();
        }

        if (!isCurrentRun() || token.isCancellationRequested) return;
        let message;
        try {
          message = output === 'stdout'
            ? stdout.trim()
            : (await vscode.env.clipboard.readText()).trim();
        } catch (error) {
          if (token.isCancellationRequested || !isCurrentRun()) return;
          throw error;
        }
        if (!isCurrentRun() || token.isCancellationRequested) return;
        if (!message) {
          throw new Error(
            output === 'stdout'
              ? 'The command did not print a commit message.'
              : 'The command did not provide a commit message in the clipboard.'
          );
        }

        if (isCurrentRun() && !token.isCancellationRequested) {
          repository.inputBox.value = message;
        }
      }
    );
  } finally {
    if (repositoryKey !== undefined && activeRuns.get(repositoryKey) === run) {
      activeRuns.delete(repositoryKey);
    }
  }
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
