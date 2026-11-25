import electron from 'electron';
import type {
  BrowserWindow as BrowserWindowType,
  MenuItemConstructorOptions
} from 'electron';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  FileNode,
  InitialState,
  MenuAction,
  OpenedFile,
  OpenedFolder,
  Settings,
  WindowState
} from '../shared/ipc.js';
import { ASSET_SCHEME, IMAGE_EXTENSIONS } from '../shared/ipc.js';

const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, screen, shell } = electron;

// Must run before the app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: ASSET_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const IMAGE_EXTENSION_SET: ReadonlySet<string> = new Set(IMAGE_EXTENSIONS);
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const IGNORED_DIRS = new Set(['node_modules']);

const DEFAULT_FONT_SIZE = 15;
const DEFAULT_UI_FONT_SIZE = 14;
const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 160;
const MAX_SIDEBAR_WIDTH = 800;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 32;

const DEFAULT_SETTINGS: Settings = {
  lastFolder: null,
  fontFamily: '',
  fontSize: DEFAULT_FONT_SIZE,
  uiFontFamily: '',
  uiFontSize: DEFAULT_UI_FONT_SIZE,
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  window: null,
  collapsedFolders: [],
  lastFile: null
};

const DEFAULT_WINDOW_WIDTH = 1120;
const DEFAULT_WINDOW_HEIGHT = 760;
const MIN_WINDOW_WIDTH = 640;
const MIN_WINDOW_HEIGHT = 420;

let mainWindow: BrowserWindowType | null = null;

function isMarkdownFile(fileName: string): boolean {
  return MARKDOWN_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

const MAX_NOTE_BASENAME_LENGTH = 120;

function extractTopHeaderTitle(content: string): string | null {
  const lines = content.split(/\r?\n/);
  const firstNonEmptyIdx = lines.findIndex((line) => line.trim().length > 0);
  if (firstNonEmptyIdx === -1) return null;

  const firstLine = lines[firstNonEmptyIdx] ?? '';
  let rawTitle: string | null = null;

  const atxMatch = firstLine.match(/^#[ \t]+(.+)$/);
  if (atxMatch) {
    rawTitle = atxMatch[1].replace(/[ \t]+#+[ \t]*$/, '').trim();
  } else {
    const secondLine = lines[firstNonEmptyIdx + 1] ?? '';
    if (!firstLine.trimStart().startsWith('#') && /^={3,}[ \t]*$/.test(secondLine)) {
      rawTitle = firstLine.trim();
    }
  }

  if (!rawTitle) return null;

  const sanitized = rawTitle
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[/\\]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .trim();

  if (!sanitized || sanitized === '.' || sanitized === '..') {
    return null;
  }

  const withoutExt = sanitized.replace(/\.(md|markdown)$/i, '').trim();
  if (!withoutExt) return null;

  return withoutExt.slice(0, MAX_NOTE_BASENAME_LENGTH).trim();
}

async function listDirectoryFileNames(dirPath: string): Promise<Set<string>> {
  const entries = await fs.readdir(dirPath);
  return new Set(entries);
}

function isEexistError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}

async function createUniqueNoteFile(
  dirPath: string,
  title: string | null,
  content: string
): Promise<OpenedFile> {
  const resolvedDir = path.resolve(dirPath);
  const existing = await listDirectoryFileNames(resolvedDir);

  if (title) {
    let suffix = 1;
    while (true) {
      const candidateName = suffix === 1 ? `${title}.md` : `${title} ${suffix}.md`;
      if (!existing.has(candidateName)) {
        const candidatePath = path.join(resolvedDir, candidateName);
        try {
          await fs.writeFile(candidatePath, content, { encoding: 'utf-8', flag: 'wx' });
          return { path: candidatePath, name: candidateName, content };
        } catch (error) {
          if (!isEexistError(error)) throw error;
          existing.add(candidateName);
        }
      }
      suffix += 1;
    }
  }

  let index = 1;
  while (true) {
    const candidateName = `UNTITLED${index}.md`;
    if (!existing.has(candidateName)) {
      const candidatePath = path.join(resolvedDir, candidateName);
      try {
        await fs.writeFile(candidatePath, content, { encoding: 'utf-8', flag: 'wx' });
        return { path: candidatePath, name: candidateName, content };
      } catch (error) {
        if (!isEexistError(error)) throw error;
        existing.add(candidateName);
      }
    }
    index += 1;
  }
}

async function renameNoteForTitle(filePath: string, content: string): Promise<OpenedFile> {
  const resolvedPath = path.resolve(filePath);
  const dirPath = path.dirname(resolvedPath);
  const currentName = path.basename(resolvedPath);
  const ext = path.extname(currentName) || '.md';
  const title = extractTopHeaderTitle(content);

  if (!title) {
    await fs.writeFile(resolvedPath, content, 'utf-8');
    return { path: resolvedPath, name: currentName, content };
  }

  const desiredName = `${title}${ext}`;
  if (desiredName === currentName) {
    await fs.writeFile(resolvedPath, content, 'utf-8');
    return { path: resolvedPath, name: currentName, content };
  }

  const existing = await listDirectoryFileNames(dirPath);
  existing.delete(currentName);

  let suffix = 1;
  while (true) {
    const candidateName = suffix === 1 ? `${title}${ext}` : `${title} ${suffix}${ext}`;
    if (candidateName === currentName) {
      await fs.writeFile(resolvedPath, content, 'utf-8');
      return { path: resolvedPath, name: currentName, content };
    }
    if (!existing.has(candidateName)) {
      const candidatePath = path.join(dirPath, candidateName);
      try {
        await fs.writeFile(candidatePath, content, { encoding: 'utf-8', flag: 'wx' });
        await fs.unlink(resolvedPath);
        return { path: candidatePath, name: candidateName, content };
      } catch (error) {
        if (!isEexistError(error)) throw error;
        existing.add(candidateName);
      }
    }
    suffix += 1;
  }
}

function getSettingsDir(): string {
  return path.join(os.homedir(), '.notewize');
}

function getSettingsPath(): string {
  return path.join(getSettingsDir(), 'notewize.json');
}

function sanitizeSettings(input: unknown): Settings {
  const result: Settings = { ...DEFAULT_SETTINGS };
  if (!input || typeof input !== 'object') return result;
  const raw = input as Record<string, unknown>;
  if (typeof raw.lastFolder === 'string' && raw.lastFolder) {
    result.lastFolder = raw.lastFolder;
  }
  if (typeof raw.fontFamily === 'string') {
    result.fontFamily = raw.fontFamily.replace(/[;{}<>\\]/g, '').trim().slice(0, 200);
  }
  if (typeof raw.fontSize === 'number' && Number.isFinite(raw.fontSize)) {
    result.fontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(raw.fontSize)));
  }
  if (typeof raw.uiFontFamily === 'string') {
    result.uiFontFamily = raw.uiFontFamily.replace(/[;{}<>\\]/g, '').trim().slice(0, 200);
  }
  if (typeof raw.uiFontSize === 'number' && Number.isFinite(raw.uiFontSize)) {
    result.uiFontSize = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(raw.uiFontSize)));
  }
  if (typeof raw.sidebarWidth === 'number' && Number.isFinite(raw.sidebarWidth)) {
    result.sidebarWidth = Math.min(
      MAX_SIDEBAR_WIDTH,
      Math.max(MIN_SIDEBAR_WIDTH, Math.round(raw.sidebarWidth))
    );
  }
  result.window = sanitizeWindowState(raw.window);
  if (Array.isArray(raw.collapsedFolders)) {
    result.collapsedFolders = raw.collapsedFolders
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .slice(0, 1000);
  }
  if (typeof raw.lastFile === 'string' && raw.lastFile) {
    result.lastFile = raw.lastFile;
  }
  return result;
}

function sanitizeWindowState(input: unknown): WindowState | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!isNum(raw.width) || !isNum(raw.height)) return null;
  const state: WindowState = {
    width: Math.max(MIN_WINDOW_WIDTH, Math.round(raw.width)),
    height: Math.max(MIN_WINDOW_HEIGHT, Math.round(raw.height)),
    maximized: raw.maximized === true
  };
  if (isNum(raw.x) && isNum(raw.y)) {
    state.x = Math.round(raw.x);
    state.y = Math.round(raw.y);
  }
  if (isNum(raw.displayId)) state.displayId = raw.displayId;
  const db = raw.displayBounds as Record<string, unknown> | undefined;
  if (db && isNum(db.x) && isNum(db.y) && isNum(db.width) && isNum(db.height)) {
    state.displayBounds = { x: db.x, y: db.y, width: db.width, height: db.height };
  }
  return state;
}

async function writeSettings(settings: Settings): Promise<void> {
  await fs.mkdir(getSettingsDir(), { recursive: true });
  await fs.writeFile(getSettingsPath(), JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

async function readLegacyLastFolder(): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const lastFolder = (parsed as { lastFolder?: unknown }).lastFolder;
      if (typeof lastFolder === 'string' && lastFolder) return lastFolder;
    }
  } catch {
    // No legacy settings
  }
  return null;
}

/** Reads settings, creating the file (and migrating the legacy last folder) if missing. */
async function readSettings(): Promise<Settings> {
  try {
    const raw = await fs.readFile(getSettingsPath(), 'utf-8');
    return sanitizeSettings(JSON.parse(raw));
  } catch (error) {
    const missing =
      typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
    const settings: Settings = { ...DEFAULT_SETTINGS };
    if (missing) {
      settings.lastFolder = await readLegacyLastFolder();
      try {
        await writeSettings(settings);
      } catch {
        // Non-fatal: continue with in-memory defaults
      }
    }
    // Invalid JSON: use defaults without overwriting the user's file
    return settings;
  }
}

async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await readSettings();
  const next = sanitizeSettings({ ...current, ...patch });
  await writeSettings(next);
  return next;
}

/** Synchronous so it can run while the window is closing. */
function saveWindowState(win: BrowserWindowType): void {
  if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  try {
    const bounds = win.getNormalBounds();
    const display = screen.getDisplayMatching(win.getBounds());
    const windowState: WindowState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized: win.isMaximized(),
      displayId: display.id,
      displayBounds: { ...display.bounds }
    };
    // A maximized window can have its restored size on a different monitor;
    // keep the restored rectangle on the monitor it is maximized on.
    if (windowState.maximized) {
      const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      if (screen.getDisplayNearestPoint(center).id !== display.id) {
        const area = display.workArea;
        windowState.width = Math.min(bounds.width, area.width);
        windowState.height = Math.min(bounds.height, area.height);
        windowState.x = area.x + Math.round((area.width - windowState.width) / 2);
        windowState.y = area.y + Math.round((area.height - windowState.height) / 2);
      }
    }
    let current: unknown = {};
    try {
      current = JSON.parse(fsSync.readFileSync(getSettingsPath(), 'utf-8'));
    } catch {
      // Missing or invalid file: start from defaults
    }
    const next = sanitizeSettings({ ...sanitizeSettings(current), window: windowState });
    fsSync.mkdirSync(getSettingsDir(), { recursive: true });
    fsSync.writeFileSync(getSettingsPath(), JSON.stringify(next, null, 2) + '\n', 'utf-8');
  } catch {
    // Non-fatal: window state is a convenience
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Works out where to open the window. Prefers the monitor it was last on; if that
 * monitor is gone (e.g. laptop-only mode) or the saved spot is off-screen, the
 * window is centered on the primary display. The result is always fully inside a
 * display's work area, so the window can never end up unreachable.
 */
function computeWindowPlacement(saved: WindowState | null): {
  x?: number;
  y?: number;
  width: number;
  height: number;
} {
  if (!saved) return { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT };

  const displays = screen.getAllDisplays();
  const sameBounds = (a: Electron.Rectangle, b: NonNullable<WindowState['displayBounds']>) =>
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

  let display: Electron.Display | undefined =
    displays.find((d) => saved.displayId !== undefined && d.id === saved.displayId) ??
    displays.find((d) => saved.displayBounds && sameBounds(d.bounds, saved.displayBounds));

  let center = display === undefined;
  if (!display) {
    // Monitor not found: keep the saved spot only if it is clearly on a connected display.
    if (saved.x !== undefined && saved.y !== undefined) {
      const rect = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
      const matching = screen.getDisplayMatching(rect);
      const area = matching.workArea;
      const overlapX = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x);
      const overlapY = Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y);
      if (overlapX >= 100 && overlapY >= 50) {
        display = matching;
        center = false;
      }
    }
    display ??= screen.getPrimaryDisplay();
  }

  const area = display.workArea;
  const width = Math.min(saved.width, area.width);
  const height = Math.min(saved.height, area.height);
  if (center || saved.x === undefined || saved.y === undefined) {
    return {
      width,
      height,
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round((area.height - height) / 2)
    };
  }
  return {
    width,
    height,
    x: clamp(saved.x, area.x, area.x + area.width - width),
    y: clamp(saved.y, area.y, area.y + area.height - height)
  };
}

async function buildFileTree(dirPath: string): Promise<FileNode[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const nodes: FileNode[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      let children: FileNode[] = [];
      try {
        children = await buildFileTree(fullPath);
      } catch {
        continue;
      }
      nodes.push({
        name: entry.name,
        path: fullPath,
        kind: 'directory',
        children
      });
    } else if (entry.isFile() && isMarkdownFile(entry.name)) {
      nodes.push({
        name: entry.name,
        path: fullPath,
        kind: 'file'
      });
    }
  }

  nodes.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });

  return nodes;
}

async function loadFolder(folderPath: string): Promise<OpenedFolder> {
  const resolved = path.resolve(folderPath);
  const tree = await buildFileTree(resolved);
  return {
    rootPath: resolved,
    name: path.basename(resolved) || resolved,
    tree
  };
}

async function loadFile(filePath: string): Promise<OpenedFile> {
  const resolved = path.resolve(filePath);
  const content = await fs.readFile(resolved, 'utf-8');
  return {
    path: resolved,
    name: path.basename(resolved),
    content
  };
}

function getCliTargetPath(): string | null {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  for (const arg of args) {
    if (!arg || arg.startsWith('-')) continue;
    return path.resolve(arg);
  }
  return null;
}

/** Reopens the last note if it still exists inside the given folder. */
async function restoreLastFile(folderRoot: string, lastFile: string | null): Promise<OpenedFile | null> {
  if (!lastFile) return null;
  const resolved = path.resolve(lastFile);
  const relative = path.relative(folderRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  if (!isMarkdownFile(resolved)) return null;
  try {
    return await loadFile(resolved);
  } catch {
    return null;
  }
}

async function resolveInitialState(): Promise<InitialState> {
  const cliTarget = getCliTargetPath();
  if (cliTarget) {
    try {
      const stat = await fs.stat(cliTarget);
      if (stat.isDirectory()) {
        const folder = await loadFolder(cliTarget);
        const previous = await readSettings();
        await updateSettings({ lastFolder: folder.rootPath });
        return { folder, file: await restoreLastFile(folder.rootPath, previous.lastFile) };
      }
      if (stat.isFile() && isMarkdownFile(cliTarget)) {
        const file = await loadFile(cliTarget);
        const folder = await loadFolder(path.dirname(cliTarget));
        return { folder, file };
      }
    } catch {
      // Fall back to saved folder
    }
  }

  const settings = await readSettings();
  if (settings.lastFolder) {
    try {
      const stat = await fs.stat(settings.lastFolder);
      if (stat.isDirectory()) {
        const folder = await loadFolder(settings.lastFolder);
        return { folder, file: await restoreLastFile(folder.rootPath, settings.lastFile) };
      }
    } catch {
      // Saved folder no longer exists
    }
  }

  return { folder: null, file: null };
}

function isSafeExternalUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

async function openExternalSafely(raw: string): Promise<boolean> {
  if (typeof raw !== 'string' || !isSafeExternalUrl(raw)) return false;
  try {
    await shell.openExternal(new URL(raw).toString());
    return true;
  } catch {
    return false;
  }
}

function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSION_SET.has(path.extname(filePath).slice(1).toLowerCase());
}

function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const filePath = path.normalize(decodeURIComponent(url.pathname));
      if (!path.isAbsolute(filePath) || !isImagePath(filePath)) {
        return new Response('Forbidden', { status: 403 });
      }
      return await net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

async function saveImageNextToNote(
  dirPath: string,
  fileName: string,
  data: ArrayBuffer
): Promise<string> {
  if (!(data instanceof ArrayBuffer) || data.byteLength === 0) {
    throw new Error('Image is empty');
  }
  if (data.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('Image is too large (50 MB max)');
  }

  const cleaned = path
    .basename(String(fileName))
    .replace(/[\x00-\x1f\x7f/\\]/g, '')
    .replace(/^\.+/, '')
    .trim();
  const ext = path.extname(cleaned).toLowerCase();
  if (!cleaned || !IMAGE_EXTENSION_SET.has(ext.slice(1))) {
    throw new Error('Unsupported image type');
  }

  const resolvedDir = path.resolve(dirPath);
  const stem = cleaned.slice(0, cleaned.length - ext.length).slice(0, 100) || 'image';
  const buffer = Buffer.from(data);

  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? `${stem}${ext}` : `${stem}-${suffix}${ext}`;
    try {
      await fs.writeFile(path.join(resolvedDir, candidate), buffer, { flag: 'wx' });
      return candidate;
    } catch (error) {
      if (!isEexistError(error)) throw error;
    }
  }
}

function sendMenuAction(action: MenuAction): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('notewize:menu-action', action);
  }
}

function createMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Note',
          accelerator: 'CmdOrCtrl+N',
          click: () => sendMenuAction('new-note')
        },
        { type: 'separator' },
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => sendMenuAction('open-folder')
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+B',
          click: () => sendMenuAction('toggle-sidebar')
        },
        {
          label: 'Toggle Preview',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => sendMenuAction('toggle-preview')
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools' }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpcHandlers(): void {
  ipcMain.handle('notewize:get-initial-state', async (): Promise<InitialState> => {
    return resolveInitialState();
  });

  ipcMain.handle('notewize:get-settings', async (): Promise<Settings> => readSettings());

  ipcMain.handle(
    'notewize:update-settings',
    async (_event, patch: Partial<Settings>): Promise<Settings> => updateSettings(patch)
  );

  ipcMain.handle(
    'notewize:open-external',
    async (_event, url: string): Promise<boolean> => openExternalSafely(url)
  );

  ipcMain.handle(
    'notewize:save-image',
    async (_event, dirPath: string, fileName: string, data: ArrayBuffer): Promise<string> =>
      saveImageNextToNote(dirPath, fileName, data)
  );

  ipcMain.handle('notewize:open-folder-dialog', async (): Promise<OpenedFolder | null> => {
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          title: 'Open Notes Folder',
          properties: ['openDirectory']
        })
      : await dialog.showOpenDialog({
          title: 'Open Notes Folder',
          properties: ['openDirectory']
        });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const folder = await loadFolder(result.filePaths[0]);
    await updateSettings({ lastFolder: folder.rootPath });
    return folder;
  });

  ipcMain.handle(
    'notewize:read-folder',
    async (_event, folderPath: string): Promise<OpenedFolder> => {
      return loadFolder(folderPath);
    }
  );

  ipcMain.handle('notewize:read-file', async (_event, filePath: string): Promise<OpenedFile> => {
    return loadFile(filePath);
  });

  ipcMain.handle(
    'notewize:create-note',
    async (_event, folderPath: string, content: string): Promise<OpenedFile> => {
      const title = extractTopHeaderTitle(content);
      return createUniqueNoteFile(folderPath, title, content);
    }
  );

  ipcMain.handle(
    'notewize:rename-note-for-title',
    async (_event, filePath: string, content: string): Promise<OpenedFile> => {
      return renameNoteForTitle(filePath, content);
    }
  );

  ipcMain.handle('notewize:delete-file', async (_event, filePath: string): Promise<void> => {
    const resolved = path.resolve(filePath);
    try {
      await shell.trashItem(resolved);
    } catch {
      await fs.unlink(resolved);
    }
  });
}

async function createMainWindow(): Promise<void> {
  const saved = (await readSettings()).window;
  const placement = computeWindowPlacement(saved);

  mainWindow = new BrowserWindow({
    ...placement,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: 'NoteWize',
    icon: path.resolve(__dirname, '../../build/icon.png'),
    backgroundColor: '#1c1c1c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Never let the app window navigate away or spawn windows; send web links to the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalSafely(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    void openExternalSafely(url);
  });

  if (saved?.maximized) mainWindow.maximize();

  const win = mainWindow;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(win), 500);
  };
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('maximize', scheduleSave);
  win.on('unmaximize', scheduleSave);
  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveWindowState(win);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl);
  } else {
    const indexPath = path.resolve(__dirname, '../../dist/index.html');
    await mainWindow.loadFile(indexPath);
  }
}

app.setName('NoteWize');
// Lets GNOME (Wayland) match the window to notewize.desktop and show its icon.
app.setDesktopName('notewize.desktop');

app.whenReady().then(async () => {
  await readSettings();
  registerAssetProtocol();
  createMenu();
  registerIpcHandlers();
  await createMainWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
