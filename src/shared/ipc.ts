/** Custom protocol used to load local images referenced by notes. */
export const ASSET_SCHEME = 'notewize-asset';

/** Image extensions that can be embedded and saved from paste/drop. */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'] as const;

export interface FileNode {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  children?: FileNode[];
}

export interface OpenedFolder {
  rootPath: string;
  name: string;
  tree: FileNode[];
}

export interface OpenedFile {
  path: string;
  name: string;
  content: string;
}

export interface InitialState {
  folder: OpenedFolder | null;
  file: OpenedFile | null;
}

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
  /** Display the window was on, used to restore it to the same monitor. */
  displayId?: number;
  displayBounds?: { x: number; y: number; width: number; height: number };
}

export interface Settings {
  lastFolder: string | null;
  /** CSS font-family value; empty means the built-in default fonts. */
  fontFamily: string;
  fontSize: number;
  /** CSS font-family for the interface; empty means the default. */
  uiFontFamily: string;
  uiFontSize: number;
  sidebarWidth: number;
  window: WindowState | null;
  /** Absolute paths of folders collapsed in the sidebar tree. */
  collapsedFolders: string[];
  lastFile: string | null;
}

export type MenuAction = 'new-note' | 'open-folder' | 'toggle-sidebar' | 'toggle-preview';

export interface NoteWizeApi {
  getInitialState(): Promise<InitialState>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  saveImage(dirPath: string, fileName: string, data: ArrayBuffer): Promise<string>;
  openExternal(url: string): Promise<boolean>;
  openFolderDialog(): Promise<OpenedFolder | null>;
  readFolder(folderPath: string): Promise<OpenedFolder>;
  readFile(filePath: string): Promise<OpenedFile>;
  createNote(folderPath: string, content: string): Promise<OpenedFile>;
  renameNoteForTitle(filePath: string, content: string): Promise<OpenedFile>;
  deleteFile(filePath: string): Promise<void>;
  onMenuAction(callback: (action: MenuAction) => void): () => void;
}
