// Minimal vscode mock for unit tests.
// Stubs the surface area used by modules under test.

export const window = {
  showWarningMessage: () => Promise.resolve(undefined),
  showInformationMessage: () => Promise.resolve(undefined),
  showErrorMessage: () => Promise.resolve(undefined),
  showQuickPick: () => Promise.resolve(undefined),
  showInputBox: () => Promise.resolve(undefined),
  showTextDocument: () => Promise.resolve(undefined),
  createStatusBarItem: () => ({
    text: '',
    tooltip: '',
    command: '',
    backgroundColor: undefined,
    show: () => {},
    hide: () => {},
    dispose: () => {},
  }),
  createOutputChannel: () => ({
    appendLine: () => {},
    append: () => {},
    clear: () => {},
    show: () => {},
    dispose: () => {},
  }),
  createWebviewPanel: () => ({
    webview: { html: '' },
    dispose: () => {},
  }),
};

export const StatusBarAlignment = { Left: 1, Right: 2 };

export const ThemeColor = class ThemeColor {
  id: string;
  constructor(id: string) { this.id = id; }
};

export const Uri = {
  file: (path: string) => ({ fsPath: path, scheme: 'file' }),
};

export const ViewColumn = { Beside: 2 };

export const ExtensionContext = {};

const configStore: Record<string, unknown> = {};
export const workspace = {
  getConfiguration: () => ({
    get: <T>(key: string, defaultValue?: T) => (configStore[key] as T) ?? defaultValue,
    update: () => Promise.resolve(),
    has: () => false,
    inspect: () => undefined,
  }),
};

export const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: () => Promise.resolve(),
};
