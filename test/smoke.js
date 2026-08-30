const assert = require('node:assert/strict');
const Module = require('node:module');

const repository = {
  rootUri: { fsPath: process.cwd() },
  inputBox: { value: '' }
};
const handlers = [];
const errors = [];
let commands = ["printf 'generated message\\n'"];
let output = 'stdout';
let repositories = [repository];
let clipboardReader = async () => '';
let cancelProgressAfter;
let cancelCurrentProgress;
const vscode = {
  workspace: {
    isTrusted: true,
    getConfiguration: () => ({
      get: (key, fallback) => key === 'command'
        ? commands.shift()
        : key === 'output' ? output : fallback
    })
  },
  extensions: {
    getExtension: () => ({
      isActive: true,
      exports: {
        getAPI: () => ({
          repositories,
          getRepository: uri => repositories.find(
            candidate => candidate.rootUri.fsPath === uri.fsPath
          )
        })
      }
    })
  },
  window: {
    withProgress: async (_options, callback) => {
      let cancelled = false;
      const listeners = new Set();
      const token = {
        get isCancellationRequested() { return cancelled; },
        onCancellationRequested: listener => {
          listeners.add(listener);
          return { dispose: () => listeners.delete(listener) };
        }
      };
      const requestCancellation = () => {
        if (cancelled) return;
        cancelled = true;
        for (const listener of listeners) listener();
      };
      cancelCurrentProgress = requestCancellation;
      const timer = cancelProgressAfter === undefined
        ? undefined
        : setTimeout(requestCancellation, cancelProgressAfter);
      try {
        return await callback(null, token);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (cancelCurrentProgress === requestCancellation) cancelCurrentProgress = undefined;
      }
    },
    showErrorMessage: async (...args) => { errors.push(args); }
  },
  ProgressLocation: { SourceControl: 1 },
  commands: {
    registerCommand: (_id, handler) => {
      handlers.push(handler);
      return { dispose() {} };
    }
  },
  env: { clipboard: { readText: () => clipboardReader() } }
};

const originalLoad = Module._load;
Module._load = (request, parent, isMain) => (
  request === 'vscode' ? vscode : originalLoad(request, parent, isMain)
);

try {
  require('../extension').activate({ subscriptions: [] });
  (async () => {
    await handlers[0]({ rootUri: { scheme: 'file', fsPath: process.cwd() } });
    assert.equal(repository.inputBox.value, 'generated message');
    console.log('stdout smoke test passed');

    commands = [
      "sleep 0.2; printf 'old\\n'",
      "sleep 0.01; printf 'new\\n'"
    ];
    const firstRun = handlers[0]();
    await new Promise(resolve => setImmediate(resolve));
    const secondRun = handlers[0]();
    await Promise.all([firstRun, secondRun]);
    assert.equal(repository.inputBox.value, 'new', 'latest invocation must win');
    console.log('concurrency regression test passed');

    commands = ["printf 'command not found' >/dev/null; exit 1"];
    await handlers[0]();
    const error = errors[errors.length - 1];
    assert.equal(error[1], undefined, 'failed commands must not be marked as missing');
    assert.match(error[0], /Command failed:/);
    console.log('command detection regression test passed');

    commands = ["printf 'command not found\\n' >&2; exit 1"];
    const stderrFalsePositiveCount = errors.length;
    await handlers[0]();
    const stderrFalsePositive = errors[stderrFalsePositiveCount];
    assert.equal(stderrFalsePositive[1], undefined, 'arbitrary stderr must not open settings');
    assert.match(stderrFalsePositive[0], /Command failed:/);
    console.log('stderr command detection regression test passed');

    const repositoryB = {
      rootUri: { fsPath: '/private/tmp' },
      inputBox: { value: '' }
    };
    repositories = [repository, repositoryB];
    commands = [
      "sleep 0.2; printf 'repository A\\n'",
      "sleep 0.01; printf 'repository B\\n'"
    ];
    const firstRepositoryRun = handlers[0]({ scheme: 'file', fsPath: process.cwd() });
    await new Promise(resolve => setTimeout(resolve, 100));
    const secondRepositoryRun = handlers[0]({ scheme: 'file', fsPath: '/private/tmp' });
    await Promise.all([firstRepositoryRun, secondRepositoryRun]);
    assert.equal(repository.inputBox.value, 'repository A');
    assert.equal(repositoryB.inputBox.value, 'repository B');
    console.log('cross-repository regression test passed');

    repositories = [repository];
    output = 'clipboard';
    commands = ['printf done', 'printf done'];
    let releaseClipboard;
    let clipboardReads = 0;
    clipboardReader = async () => clipboardReads++ === 0
      ? new Promise(resolve => { releaseClipboard = resolve; })
      : 'repository B';
    const firstClipboardRun = handlers[0]();
    await new Promise(resolve => setTimeout(resolve, 100));
    const secondClipboardRun = handlers[0]();
    await new Promise(resolve => setTimeout(resolve, 100));
    releaseClipboard('');
    const errorCount = errors.length;
    await Promise.all([firstClipboardRun, secondClipboardRun]);
    assert.equal(errors.length, errorCount, 'superseded clipboard runs must not show errors');
    assert.equal(repository.inputBox.value, 'repository B');
    console.log('clipboard cancellation regression test passed');

    commands = ['printf done', 'printf done'];
    clipboardReads = 0;
    let releaseHangingClipboard;
    clipboardReader = async () => clipboardReads++ === 0
      ? new Promise(resolve => { releaseHangingClipboard = resolve; })
      : 'repository C';
    const hangingClipboardRun = handlers[0]();
    await new Promise(resolve => setTimeout(resolve, 100));
    await handlers[0]();
    const hangingRunSettled = await Promise.race([
      hangingClipboardRun.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 100))
    ]);
    assert.equal(hangingRunSettled, true, 'superseded clipboard reads must be cancellable');
    releaseHangingClipboard('ignored');
    await hangingClipboardRun;
    console.log('clipboard hang cancellation regression test passed');

    commands = ['printf done'];
    let releaseCancelledClipboard;
    clipboardReader = async () => new Promise(resolve => {
      releaseCancelledClipboard = resolve;
      cancelCurrentProgress();
    });
    cancelProgressAfter = undefined;
    const cancelledClipboardRun = handlers[0]();
    const cancelledRunSettled = await Promise.race([
      cancelledClipboardRun.then(() => true),
      new Promise(resolve => setTimeout(() => resolve(false), 200))
    ]);
    cancelProgressAfter = undefined;
    assert.equal(cancelledRunSettled, true, 'user cancellation must stop clipboard reads');
    releaseCancelledClipboard('ignored');
    await cancelledClipboardRun;
    console.log('user clipboard cancellation regression test passed');

    output = 'stdout';
    clipboardReader = async () => '';
    commands = ['/definitely/missing-aicommits-command'];
    const missingCommandErrorCount = errors.length;
    await handlers[0]();
    const missingCommandError = errors[missingCommandErrorCount];
    assert.equal(missingCommandError[1], 'Open Settings');
    console.log('missing command regression test passed');

    repositories = [{
      rootUri: { fsPath: '/definitely/missing-aicommits-dir' },
      inputBox: { value: '' }
    }];
    commands = ['printf ok'];
    const missingDirectoryErrorCount = errors.length;
    await handlers[0]();
    const missingDirectoryError = errors[missingDirectoryErrorCount];
    assert.equal(missingDirectoryError[1], undefined, 'missing cwd must not open command settings');
    assert.match(missingDirectoryError[0], /ENOENT/);
    console.log('missing directory regression test passed');

    repositories = [repository];
    if (process.platform !== 'win32') {
      cancelProgressAfter = 50;
      commands = ['sleep 2 &'];
      const cancellationStart = Date.now();
      await handlers[0]();
      const cancellationElapsed = Date.now() - cancellationStart;
      cancelProgressAfter = undefined;
      assert.ok(
        cancellationElapsed < 1000,
        `cancelling a background command took ${cancellationElapsed}ms`
      );
      console.log('process group cancellation regression test passed');
    }
  })().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
} finally {
  Module._load = originalLoad;
}
