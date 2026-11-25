<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Carta, MarkdownEditor } from 'carta-md';
  import DOMPurify from 'dompurify';
  import './carta-theme.css';
  import { mermaidPlugin } from './plugins/mermaid.js';
  import { localAssetsPlugin } from './plugins/localAssets.js';
  import { ASSET_SCHEME, IMAGE_EXTENSIONS } from '../shared/ipc.js';
  import FileTree from './components/FileTree.svelte';
  import type { OpenedFile, OpenedFolder, Settings } from '../shared/ipc.js';

  const NEW_NOTE_PREFIX = '# ';
  const AUTOSAVE_DELAY_MS = 500;

  type EditorMode = 'write' | 'preview';

  function getNoteDir(): string | null {
    return activeFile ? getParentDir(activeFile.path) : draftDir;
  }

  function createCarta(): Carta {
    return new Carta({
      sanitizer: (html) =>
        DOMPurify.sanitize(html, {
          // Default allow-list plus the protocol used for local images.
          ALLOWED_URI_REGEXP: new RegExp(
            `^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|${ASSET_SCHEME}):|[^a-z]|[a-z+.\\-]+(?:[^a-z+.\\-:]|$))`,
            'i'
          )
        }),
      extensions: [mermaidPlugin(), localAssetsPlugin(getNoteDir)],
      theme: {
        light: 'github-light',
        dark: 'github-dark'
      }
    });
  }

  let sidebarOpen = $state(true);
  let folder = $state<OpenedFolder | null>(null);
  let activeFile = $state<OpenedFile | null>(null);
  let draftDir = $state<string | null>(null);
  let editorContent = $state('');
  let savedContent = $state('');
  let statusMessage = $state('');
  let errorMessage = $state('');
  let editorMode = $state<EditorMode>('write');
  let noteSessionId = $state(0);
  let carta = $state<Carta>(createCarta());
  let settings = $state<Settings>({
    lastFolder: null,
    fontFamily: '',
    fontSize: 15,
    uiFontFamily: '',
    uiFontSize: 14,
    sidebarWidth: 260,
    window: null,
    collapsedFolders: [],
    lastFile: null
  });
  let collapsedSet = $derived(new Set(settings.collapsedFolders));
  let initialLoaded = $state(false);
  let sidebarWidth = $state(260);
  let resizing = $state(false);
  let settingsOpen = $state(false);

  const FONT_SUGGESTIONS = [
    'system-ui',
    'sans-serif',
    'serif',
    'monospace',
    'JetBrains Mono',
    'Fira Code',
    'Source Code Pro',
    'DejaVu Sans',
    'DejaVu Sans Mono',
    'Noto Sans',
    'Noto Serif',
    'Ubuntu',
    'Cantarell',
    'Liberation Sans',
    'Liberation Serif'
  ];

  async function saveSettings(patch: Partial<Settings>): Promise<void> {
    try {
      settings = await window.notewize.updateSettings(patch);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Failed to save settings';
    }
  }

  function handleToggleDir(dirPath: string): void {
    const next = new Set(settings.collapsedFolders);
    if (!next.delete(dirPath)) next.add(dirPath);
    const collapsedFolders = [...next];
    settings.collapsedFolders = collapsedFolders;
    void saveSettings({ collapsedFolders });
  }

  // Remember the open note (only after startup restore has finished).
  $effect(() => {
    if (!initialLoaded) return;
    const lastFile = activeFile?.path ?? null;
    if (lastFile !== settings.lastFile) void saveSettings({ lastFile });
  });

  const MIN_SIDEBAR = 160;
  const MIN_MAIN = 320;

  function clampSidebar(width: number): number {
    const max = Math.max(MIN_SIDEBAR, Math.min(800, window.innerWidth - MIN_MAIN));
    return Math.round(Math.min(max, Math.max(MIN_SIDEBAR, width)));
  }

  function startResize(event: PointerEvent): void {
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    resizing = true;
  }

  function moveResize(event: PointerEvent): void {
    if (!resizing) return;
    sidebarWidth = clampSidebar(event.clientX);
  }

  function endResize(event: PointerEvent): void {
    if (!resizing) return;
    resizing = false;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    void saveSettings({ sidebarWidth });
  }

  function handleResizeKey(event: KeyboardEvent): void {
    const step = event.shiftKey ? 40 : 10;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    sidebarWidth = clampSidebar(sidebarWidth + (event.key === 'ArrowRight' ? step : -step));
    void saveSettings({ sidebarWidth });
  }

  function handleSizeInput(event: Event, key: 'fontSize' | 'uiFontSize'): void {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    if (Number.isFinite(value) && value >= 10 && value <= 32) {
      void saveSettings({ [key]: value });
    }
  }

  $effect(() => {
    const root = document.documentElement.style;
    if (settings.fontFamily) root.setProperty('--user-font', settings.fontFamily);
    else root.removeProperty('--user-font');
    root.setProperty('--base-font-size', `${settings.fontSize}px`);
    if (settings.uiFontFamily) root.setProperty('--ui-font', settings.uiFontFamily);
    else root.removeProperty('--ui-font');
    root.setProperty('--ui-font-size', `${settings.uiFontSize}px`);
    root.setProperty('--ui-scale', String(settings.uiFontSize / 14));
  });

  let isDraft = $derived(draftDir !== null && activeFile === null);
  let hasEditor = $derived(activeFile !== null || isDraft);
  let isDirty = $derived(
    activeFile !== null
      ? editorContent !== savedContent
      : isDraft && hasMeaningfulNoteContent(editorContent)
  );

  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let saveInFlight: Promise<void> | null = null;
  let saveQueued = false;

  function hasMeaningfulNoteContent(content: string): boolean {
    return content.replace(/^#[ \t]*/, '').trim().length > 0;
  }

  function resetEditorSession(): void {
    carta = createCarta();
    noteSessionId += 1;
  }

  function clearAutoSaveTimer(): void {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
  }

  function showStatus(message: string): void {
    statusMessage = message;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusMessage = '';
    }, 2000);
  }

  function setOpenedFile(file: OpenedFile): void {
    clearAutoSaveTimer();
    draftDir = null;
    activeFile = file;
    editorContent = file.content;
    savedContent = file.content;
    errorMessage = '';
    resetEditorSession();
  }

  async function refreshFolderQuietly(): Promise<void> {
    if (!folder) return;
    try {
      folder = await window.notewize.readFolder(folder.rootPath);
    } catch {
      // Ignore background tree refresh errors
    }
  }

  async function persistNote(): Promise<void> {
    if (saveInFlight) {
      saveQueued = true;
      await saveInFlight;
      return;
    }

    const run = async (): Promise<void> => {
      do {
        saveQueued = false;
        const contentToSave = editorContent;

        if (draftDir !== null && activeFile === null) {
          if (!hasMeaningfulNoteContent(contentToSave)) {
            return;
          }
          const targetDir = draftDir;
          const created = await window.notewize.createNote(targetDir, contentToSave);
          if (draftDir === targetDir && activeFile === null) {
            activeFile = created;
            draftDir = null;
            savedContent = contentToSave;
            showStatus(`Saved ${created.name}`);
            await refreshFolderQuietly();
          }
        } else if (activeFile !== null) {
          if (contentToSave === savedContent) {
            return;
          }
          const prevPath = activeFile.path;
          const updated = await window.notewize.renameNoteForTitle(prevPath, contentToSave);
          if (activeFile?.path === prevPath) {
            const pathChanged = updated.path !== prevPath;
            activeFile = updated;
            savedContent = contentToSave;
            if (pathChanged) {
              showStatus(`Renamed to ${updated.name}`);
              await refreshFolderQuietly();
            }
          }
        }
      } while (saveQueued);
    };

    errorMessage = '';
    saveInFlight = run()
      .catch((error: unknown) => {
        errorMessage = error instanceof Error ? error.message : 'Failed to save note';
      })
      .finally(() => {
        saveInFlight = null;
      });

    await saveInFlight;
  }

  function scheduleAutoSave(): void {
    if (!hasEditor) return;
    clearAutoSaveTimer();

    if (isDraft && !hasMeaningfulNoteContent(editorContent)) {
      return;
    }

    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = null;
      void persistNote();
    }, AUTOSAVE_DELAY_MS);
  }

  async function flushBeforeLeaving(): Promise<boolean> {
    clearAutoSaveTimer();
    if (isDirty) {
      await persistNote();
    }
    return !errorMessage;
  }

  function getParentDir(filePath: string): string {
    const lastSlash = filePath.lastIndexOf('/');
    return lastSlash > 0 ? filePath.slice(0, lastSlash) : '/';
  }

  async function focusEditorAt(position?: number): Promise<void> {
    await tick();
    const textarea = carta.input?.textarea;
    if (!textarea) return;
    textarea.focus({ preventScroll: true });
    if (typeof position === 'number') {
      textarea.setSelectionRange(position, position);
    }
  }

  function getScroller(mode: EditorMode): HTMLElement | null {
    return document.querySelector<HTMLElement>(
      mode === 'write' ? '.carta-input' : '.carta-renderer'
    );
  }

  function getScrollFraction(el: HTMLElement | null): number {
    if (!el) return 0;
    const max = el.scrollHeight - el.clientHeight;
    return max > 0 ? el.scrollTop / max : 0;
  }

  function applyScrollFraction(el: HTMLElement | null, fraction: number): void {
    if (!el) return;
    el.scrollTop = fraction * (el.scrollHeight - el.clientHeight);
  }

  async function toggleEditorMode(): Promise<void> {
    if (!hasEditor) return;
    const fraction = getScrollFraction(getScroller(editorMode));
    const nextMode: EditorMode = editorMode === 'write' ? 'preview' : 'write';

    if (editorMode === 'write' && isDirty) {
      clearAutoSaveTimer();
      void persistNote();
    }
    editorMode = nextMode;
    if (nextMode === 'write') await focusEditorAt();
    else await tick();

    // Carta restores its own (stale) scroll position after the tab switch and
    // rendering is debounced, so re-apply the shared position over a few frames.
    const target = getScroller(nextMode);
    for (const delay of [0, 60, 200, 450]) {
      setTimeout(() => applyScrollFraction(target, fraction), delay);
    }
  }

  async function handleNewNote(): Promise<void> {
    if (isDraft && !hasMeaningfulNoteContent(editorContent)) {
      editorMode = 'write';
      await focusEditorAt(NEW_NOTE_PREFIX.length);
      return;
    }

    if (!(await flushBeforeLeaving())) return;

    let targetDir = folder?.rootPath ?? (activeFile ? getParentDir(activeFile.path) : null);
    if (!targetDir) {
      await handleOpenFolder();
      targetDir = folder?.rootPath ?? null;
      if (!targetDir) return;
    }

    clearAutoSaveTimer();
    activeFile = null;
    draftDir = targetDir;
    editorContent = NEW_NOTE_PREFIX;
    savedContent = NEW_NOTE_PREFIX;
    errorMessage = '';
    editorMode = 'write';
    resetEditorSession();

    await focusEditorAt(NEW_NOTE_PREFIX.length);
  }

  async function handleOpenFolder(): Promise<void> {
    errorMessage = '';
    try {
      const opened = await window.notewize.openFolderDialog();
      if (opened) {
        folder = opened;
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Failed to open folder';
    }
  }

  async function handleRefreshFolder(): Promise<void> {
    if (!folder) return;
    errorMessage = '';
    try {
      folder = await window.notewize.readFolder(folder.rootPath);
      showStatus('Folder refreshed');
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Failed to refresh folder';
    }
  }

  async function handleSelectFile(filePath: string): Promise<void> {
    if (activeFile?.path === filePath) return;
    if (!(await flushBeforeLeaving())) return;
    errorMessage = '';
    try {
      const opened = await window.notewize.readFile(filePath);
      setOpenedFile(opened);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Failed to read file';
    }
  }

  async function openLink(href: string): Promise<void> {
    if (!href || href.startsWith('#')) return;

    if (/^https?:\/\//i.test(href)) {
      const opened = await window.notewize.openExternal(href);
      if (!opened) errorMessage = `Could not open ${href}`;
      return;
    }

    // Any other scheme (mailto:, file:, javascript:, ...) is ignored.
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return;
    if (!activeFile) return;

    let targetPath: string;
    try {
      const resolved = new URL(href, `file://${encodeURI(activeFile.path)}`);
      targetPath = decodeURIComponent(resolved.pathname);
    } catch {
      errorMessage = `Invalid link: ${href}`;
      return;
    }

    if (!/\.(md|markdown)$/i.test(targetPath)) {
      errorMessage = `Only Markdown links can be opened: ${href}`;
      return;
    }
    await handleSelectFile(targetPath);
  }

  const LINK_PATTERN =
    /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|https?:\/\/[^\s<>)\]]+/g;

  /** Finds the Markdown link or bare URL under the given offset in the text. */
  function findLinkAt(text: string, offset: number): string | null {
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const lineEndIdx = text.indexOf('\n', offset);
    const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
    const line = text.slice(lineStart, lineEnd);
    const col = offset - lineStart;

    for (const match of line.matchAll(LINK_PATTERN)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (col < start || col > end) continue;
      return match[1] ?? match[0].replace(/[.,;:!?'"]+$/, '');
    }
    return null;
  }

  async function handleLinkClick(event: MouseEvent): Promise<void> {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const anchor = target.closest<HTMLAnchorElement>('.carta-renderer a');
    if (anchor) {
      event.preventDefault();
      await openLink(anchor.getAttribute('href')?.trim() ?? '');
      return;
    }

    // Edit mode: Ctrl/Cmd+click on a link in the Markdown source.
    if (!(event.ctrlKey || event.metaKey)) return;
    if (!(target instanceof HTMLTextAreaElement) || !target.closest('.carta-input')) return;
    const href = findLinkAt(target.value, target.selectionStart);
    if (!href) return;
    event.preventDefault();
    await openLink(href);
  }

  const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/avif': 'avif'
  };

  function imageFileName(file: File): string | null {
    const dot = file.name.lastIndexOf('.');
    const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : '';
    const mimeExt = IMAGE_MIME_EXTENSIONS[file.type];
    const known = (IMAGE_EXTENSIONS as readonly string[]).includes(ext);
    if (!known && !mimeExt) return null;

    const generic = !file.name || /^image\.\w+$/i.test(file.name);
    if (generic) {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
      return `image-${stamp}.${mimeExt ?? ext}`;
    }
    return known ? file.name : `${file.name}.${mimeExt}`;
  }

  function markdownImage(fileName: string): string {
    const alt = fileName.replace(/\.[^.]+$/, '');
    const url = encodeURIComponent(fileName).replace(/\(/g, '%28').replace(/\)/g, '%29');
    return `![${alt.replace(/[\[\]]/g, '')}](${url})`;
  }

  async function insertImages(files: File[], textarea: HTMLTextAreaElement): Promise<void> {
    const dir = getNoteDir();
    if (!dir) {
      errorMessage = 'Open a folder or create a note before adding images';
      return;
    }

    let offset = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const snippets: string[] = [];
    for (const file of files) {
      const name = imageFileName(file);
      if (!name) continue;
      try {
        const saved = await window.notewize.saveImage(dir, name, await file.arrayBuffer());
        snippets.push(markdownImage(saved));
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : 'Failed to save image';
      }
    }
    if (snippets.length === 0) return;

    const text = snippets.join('\n');
    const current = editorContent;
    offset = Math.min(offset, current.length);
    const tail = Math.min(Math.max(end, offset), current.length);
    editorContent = current.slice(0, offset) + text + current.slice(tail);
    showStatus(snippets.length === 1 ? 'Image added' : `${snippets.length} images added`);
    await focusEditorAt(offset + text.length);
  }

  function getEditorTextarea(event: Event): HTMLTextAreaElement | null {
    const target = event.target;
    return target instanceof HTMLTextAreaElement && target.closest('.carta-input') ? target : null;
  }

  function handlePaste(event: ClipboardEvent): void {
    const textarea = getEditorTextarea(event);
    if (!textarea) return;
    const images = Array.from(event.clipboardData?.files ?? []).filter((f) =>
      f.type.startsWith('image/')
    );
    if (images.length === 0) return;
    event.preventDefault();
    void insertImages(images, textarea);
  }

  function handleDragOver(event: DragEvent): void {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  }

  function handleDrop(event: DragEvent): void {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    // Never let a dropped file navigate the window.
    event.preventDefault();
    const textarea = getEditorTextarea(event);
    if (!textarea) return;
    const images = files.filter((f) => imageFileName(f) !== null);
    if (images.length === 0) {
      errorMessage = 'Only image files can be dropped into a note';
      return;
    }
    // Place the caret where the files were dropped.
    const caret = caretOffsetFromPoint(event.clientX, event.clientY, textarea);
    if (caret !== null) textarea.setSelectionRange(caret, caret);
    void insertImages(images, textarea);
  }

  /** Best-effort mapping of a drop point to a textarea offset. */
  function caretOffsetFromPoint(x: number, y: number, textarea: HTMLTextAreaElement): number | null {
    const doc = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    const pos = doc.caretPositionFromPoint?.(x, y);
    if (pos && pos.offsetNode === textarea) return pos.offset;
    return null;
  }

  async function handleDeleteNote(): Promise<void> {
    if (!hasEditor) return;

    clearAutoSaveTimer();
    if (saveInFlight) {
      await saveInFlight;
    }

    if (activeFile) {
      const target = activeFile;
      if (!window.confirm(`Delete "${target.name}"?`)) return;
      errorMessage = '';
      try {
        await window.notewize.deleteFile(target.path);
        activeFile = null;
        draftDir = null;
        editorContent = '';
        savedContent = '';
        await refreshFolderQuietly();
        showStatus(`Deleted ${target.name}`);
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : 'Failed to delete file';
      }
      return;
    }

    if (isDraft) {
      if (hasMeaningfulNoteContent(editorContent)) {
        if (!window.confirm('Discard this new note?')) return;
      }
      draftDir = null;
      editorContent = '';
      savedContent = '';
      errorMessage = '';
      showStatus('Draft discarded');
    }
  }

  function handleEditorBlur(): void {
    if (hasEditor && isDirty) {
      clearAutoSaveTimer();
      void persistNote();
    }
  }

  $effect(() => {
    const content = editorContent;
    if (!hasEditor) return;
    if (activeFile !== null) {
      if (content !== savedContent) {
        scheduleAutoSave();
      }
    } else if (isDraft && hasMeaningfulNoteContent(content)) {
      scheduleAutoSave();
    }
  });

  onMount(() => {
    let active = true;

    void window.notewize
      .getSettings()
      .then((loaded) => {
        if (!active) return;
        settings = loaded;
        sidebarWidth = loaded.sidebarWidth;
      })
      .catch(() => {
        // Keep defaults
      });

    void window.notewize
      .getInitialState()
      .then((initial) => {
        if (!active) return;
        folder = initial.folder;
        if (initial.file) {
          setOpenedFile(initial.file);
        }
        initialLoaded = true;
      })
      .catch((error: unknown) => {
        if (!active) return;
        errorMessage = error instanceof Error ? error.message : 'Failed to initialize';
        initialLoaded = true;
      });

    const unsubscribeMenu = window.notewize.onMenuAction((action) => {
      if (action === 'new-note') void handleNewNote();
      else if (action === 'open-folder') void handleOpenFolder();
      else if (action === 'toggle-sidebar') sidebarOpen = !sidebarOpen;
      else if (action === 'toggle-preview') void toggleEditorMode();
    });

    const handleBeforeUnload = () => {
      if (isDirty) {
        clearAutoSaveTimer();
        void persistNote();
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('click', handleLinkClick);
    document.addEventListener('paste', handlePaste);
    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('drop', handleDrop);

    return () => {
      active = false;
      unsubscribeMenu();
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('click', handleLinkClick);
      document.removeEventListener('paste', handlePaste);
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('drop', handleDrop);
      if (statusTimer) clearTimeout(statusTimer);
      clearAutoSaveTimer();
    };
  });
</script>

<div class="app-shell">
  <header class="app-header">
    {#if sidebarOpen}
      <div class="header-sidebar" style:width="{sidebarWidth}px">
        <div class="btn-group">
          <button
            type="button"
            class="tool-btn"
            onclick={() => (sidebarOpen = false)}
            title="Collapse Sidebar (Ctrl+B)"
            aria-label="Collapse Sidebar"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
          <button
            type="button"
            class="tool-btn"
            onclick={handleOpenFolder}
            title="Open Folder (Ctrl+Shift+O)"
            aria-label="Open Folder"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z" />
            </svg>
          </button>
          {#if folder}
            <button
              type="button"
              class="tool-btn"
              onclick={handleRefreshFolder}
              title="Refresh Folder"
              aria-label="Refresh Folder"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <polyline points="21 3 21 9 15 9" />
              </svg>
            </button>
          {/if}
        </div>

        <button
          type="button"
          class="tool-btn standalone"
          onclick={handleNewNote}
          title="New Note (Ctrl+N)"
          aria-label="New Note"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
    {/if}

    <div class="header-main">
      <div class="toolbar-left">
        {#if !sidebarOpen}
          <div class="btn-group">
            <button
              type="button"
              class="tool-btn"
              onclick={() => (sidebarOpen = true)}
              title="Expand Sidebar (Ctrl+B)"
              aria-label="Expand Sidebar"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            </button>
            <button
              type="button"
              class="tool-btn"
              onclick={handleNewNote}
              title="New Note (Ctrl+N)"
              aria-label="New Note"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
        {/if}

        <button
          type="button"
          class="tool-btn standalone delete-btn"
          onclick={handleDeleteNote}
          disabled={!hasEditor}
          title="Delete Note"
          aria-label="Delete Note"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M9 3a1 1 0 0 0-1 1v1H4a1 1 0 1 0 0 2h1v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7h1a1 1 0 1 0 0-2h-4V4a1 1 0 0 0-1-1H9zm1 2h4v0h-4z" />
          </svg>
        </button>

        <button
          type="button"
          class="tool-btn standalone mode-toggle-btn"
          class:active={editorMode === 'preview'}
          onclick={toggleEditorMode}
          disabled={!hasEditor}
          title={editorMode === 'write'
            ? 'Switch to Preview (Ctrl+Shift+P)'
            : 'Switch to Editor (Ctrl+Shift+P)'}
          aria-label={editorMode === 'write' ? 'Switch to Preview' : 'Switch to Editor'}
          aria-pressed={editorMode === 'preview'}
        >
          {#if editorMode === 'write'}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <span>Preview</span>
          {:else}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
            <span>Edit</span>
          {/if}
        </button>
      </div>

      <div class="toolbar-right">
        {#if statusMessage}
          <span class="status-text">{statusMessage}</span>
        {/if}
        <button
          type="button"
          class="tool-btn standalone"
          onclick={() => (settingsOpen = true)}
          title="Settings"
          aria-label="Settings"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </div>
  </header>

  <div class="workspace">
    {#if sidebarOpen}
      <aside class="sidebar" aria-label="Files" style:width="{sidebarWidth}px">
        {#if folder}
          <div class="folder-bar" title={folder.rootPath}>
            <span class="folder-name">{folder.name}</span>
          </div>
          <div class="tree-scroll">
            {#if folder.tree.length > 0}
              <FileTree
                nodes={folder.tree}
                activeFilePath={activeFile?.path ?? null}
                collapsed={collapsedSet}
                onSelectFile={handleSelectFile}
                onToggleDir={handleToggleDir}
              />
            {:else}
              <p class="sidebar-empty">No Markdown files in this folder.</p>
            {/if}
          </div>
        {:else}
          <div class="sidebar-placeholder">
            <p>No folder opened.</p>
            <button type="button" class="primary-btn" onclick={handleOpenFolder}>
              Open Folder
            </button>
          </div>
        {/if}
      </aside>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
      <div
        class="resize-handle"
        class:active={resizing}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={sidebarWidth}
        tabindex="0"
        onpointerdown={startResize}
        onpointermove={moveResize}
        onpointerup={endResize}
        onpointercancel={endResize}
        onkeydown={handleResizeKey}
      ></div>
    {/if}

    <main class="editor-pane">
      {#if errorMessage}
        <div class="error-banner" role="alert">
          <span>{errorMessage}</span>
          <button type="button" onclick={() => (errorMessage = '')} aria-label="Dismiss error">
            ✕
          </button>
        </div>
      {/if}

      {#if hasEditor}
        {#key noteSessionId}
          <MarkdownEditor
            {carta}
            theme="notewize"
            mode="tabs"
            selectedTab={editorMode}
            disableToolbar={true}
            bind:value={editorContent}
            placeholder="Write Markdown here..."
            textarea={{ spellcheck: false, onblur: handleEditorBlur }}
          />
        {/key}
      {:else}
        <section class="empty-state">
          <h1>NoteWize</h1>
          <p>
            {#if folder}
              Select a note from the sidebar or create a new Markdown note.
            {:else}
              Open a folder to browse and edit your Markdown notes.
            {/if}
          </p>
          <div class="empty-actions">
            {#if folder}
              <button type="button" class="primary-btn" onclick={handleNewNote}>
                + New Note
              </button>
            {:else}
              <button type="button" class="primary-btn" onclick={handleOpenFolder}>
                Open Folder
              </button>
            {/if}
          </div>
        </section>
      {/if}
    </main>
  </div>
</div>

{#if settingsOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="modal-backdrop" onclick={() => (settingsOpen = false)}>
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.key === 'Escape' && (settingsOpen = false)}
    >
      <div class="modal-header">
        <h2 id="settings-title">Settings</h2>
        <button type="button" class="modal-close" onclick={() => (settingsOpen = false)} aria-label="Close settings">✕</button>
      </div>

      <label class="field">
        <span>Editor &amp; preview font</span>
        <input
          type="text"
          list="font-suggestions"
          value={settings.fontFamily}
          placeholder="Default"
          spellcheck="false"
          onchange={(e) => saveSettings({ fontFamily: e.currentTarget.value })}
        />
        <datalist id="font-suggestions">
          {#each FONT_SUGGESTIONS as font (font)}
            <option value={font}></option>
          {/each}
        </datalist>
        <small>Any installed font name. Leave empty for the default fonts.</small>
      </label>

      <label class="field">
        <span>Editor &amp; preview font size (px)</span>
        <input
          type="number"
          min="10"
          max="32"
          step="1"
          value={settings.fontSize}
          onchange={(e) => handleSizeInput(e, 'fontSize')}
        />
      </label>

      <label class="field">
        <span>Interface font</span>
        <input
          type="text"
          list="font-suggestions"
          value={settings.uiFontFamily}
          placeholder="Default"
          spellcheck="false"
          onchange={(e) => saveSettings({ uiFontFamily: e.currentTarget.value })}
        />
      </label>

      <label class="field">
        <span>Interface font size (px)</span>
        <input
          type="number"
          min="10"
          max="32"
          step="1"
          value={settings.uiFontSize}
          onchange={(e) => handleSizeInput(e, 'uiFontSize')}
        />
      </label>

      <div class="modal-actions">
        <button
          type="button"
          onclick={() => saveSettings({ fontFamily: '', fontSize: 15, uiFontFamily: '', uiFontSize: 14 })}
        >
          Reset
        </button>
        <button type="button" class="primary-btn" onclick={() => (settingsOpen = false)}>
          Done
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .app-shell {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  .app-header {
    height: calc(50px * var(--ui-scale, 1));
    display: flex;
    align-items: stretch;
    background: var(--bg-header);
    border-bottom: 1px solid var(--border-strong);
    flex-shrink: 0;
    user-select: none;
  }

  .header-sidebar {
    width: 260px;
    min-width: calc(200px * var(--ui-scale, 1));
    max-width: 420px;
    padding: 0 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    border-right: 1px solid var(--border-strong);
    flex-shrink: 0;
  }

  .header-main {
    flex: 1;
    min-width: 0;
    padding: 0 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .toolbar-left,
  .toolbar-right {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .btn-group {
    display: inline-flex;
    align-items: center;
    border-radius: 4px;
    overflow: hidden;
    border: 1px solid var(--border-strong);
    background: var(--bg-btn);
  }

  .btn-group .tool-btn {
    border: none;
    border-radius: 0;
    border-right: 1px solid var(--border-strong);
  }

  .btn-group .tool-btn:last-child {
    border-right: none;
  }

  .tool-btn svg {
    width: 1.2em;
    height: 1.2em;
    flex-shrink: 0;
  }

  .tool-btn {
    height: calc(32px * var(--ui-scale, 1));
    min-width: calc(38px * var(--ui-scale, 1));
    padding: 0 10px;
    font-size: calc(14px * var(--ui-scale, 1));
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-btn);
    color: var(--text-primary);
    border-radius: 4px;
    transition: background-color 120ms ease, color 120ms ease;
  }

  .tool-btn.standalone {
    border: 1px solid var(--border-strong);
  }

  .tool-btn:hover:not(:disabled) {
    background: var(--bg-btn-hover);
    color: #ffffff;
  }

  .tool-btn:active:not(:disabled) {
    background: var(--bg-btn-active);
  }

  .delete-btn:hover:not(:disabled) {
    color: var(--danger);
  }

  .mode-toggle-btn {
    gap: 6px;
    padding: 0 11px;
    font-size: calc(13px * var(--ui-scale, 1));
    font-weight: 500;
  }

  .mode-toggle-btn.active {
    background: var(--bg-btn-active);
    color: var(--accent);
    border-color: rgba(245, 124, 0, 0.45);
  }

  .mode-toggle-btn.active:hover:not(:disabled) {
    color: var(--accent-hover);
  }

  .resize-handle {
    position: relative;
    z-index: 5;
    width: 6px;
    margin: 0 -3px;
    flex-shrink: 0;
    cursor: col-resize;
    background: transparent;
    transition: background-color 120ms ease;
  }

  .resize-handle:hover,
  .resize-handle.active,
  .resize-handle:focus-visible {
    background: var(--accent);
    outline: none;
  }

  .workspace {
    flex: 1;
    min-height: 0;
    display: flex;
    width: 100%;
    overflow: hidden;
  }

  .sidebar {
    width: 260px;
    min-width: calc(200px * var(--ui-scale, 1));
    max-width: 420px;
    display: flex;
    flex-direction: column;
    background: var(--bg-sidebar);
    border-right: 1px solid var(--border-strong);
    user-select: none;
    flex-shrink: 0;
  }

  .folder-bar {
    height: calc(36px * var(--ui-scale, 1));
    padding: 0 14px;
    display: flex;
    align-items: center;
    background: var(--bg-sidebar-subheader);
    border-bottom: 1px solid var(--border-strong);
    flex-shrink: 0;
  }

  .folder-name {
    font-size: calc(13px * var(--ui-scale, 1));
    font-weight: 500;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tree-scroll {
    flex: 1;
    overflow-y: auto;
    padding-bottom: 12px;
  }

  .sidebar-placeholder,
  .sidebar-empty {
    padding: 20px 14px;
    color: var(--text-secondary);
    font-size: calc(13px * var(--ui-scale, 1));
  }

  .sidebar-placeholder {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }

  .sidebar-placeholder p,
  .sidebar-empty {
    margin: 0;
  }

  .editor-pane {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background: var(--bg-main);
  }

  .status-text {
    font-size: calc(12px * var(--ui-scale, 1));
    color: var(--text-muted);
    white-space: nowrap;
  }

  .primary-btn {
    padding: 8px 16px;
    font-size: calc(13px * var(--ui-scale, 1));
    font-weight: 500;
    background: var(--accent);
    color: #141414;
  }

  .primary-btn:hover {
    background: var(--accent-hover);
  }

  .error-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 14px;
    background: rgba(239, 83, 80, 0.14);
    border-bottom: 1px solid rgba(239, 83, 80, 0.35);
    color: var(--danger);
    font-size: calc(13px * var(--ui-scale, 1));
  }

  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 24px;
    text-align: center;
    color: var(--text-secondary);
  }

  .empty-state h1 {
    margin: 0;
    font-size: calc(22px * var(--ui-scale, 1));
    font-weight: 600;
    color: var(--text-primary);
  }

  .empty-state p {
    margin: 0;
    max-width: 420px;
    line-height: 1.5;
  }

  .empty-actions {
    display: flex;
    gap: 10px;
    margin-top: 6px;
  }
  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.55);
  }

  .modal {
    width: 380px;
    max-width: calc(100vw - 32px);
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    background: var(--bg-header);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .modal-header h2 {
    margin: 0;
    font-size: calc(16px * var(--ui-scale, 1));
    font-weight: 600;
  }

  .modal-close {
    width: 28px;
    height: calc(28px * var(--ui-scale, 1));
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: calc(13px * var(--ui-scale, 1));
    color: var(--text-secondary);
  }

  .field input {
    padding: 7px 10px;
    font: inherit;
    color: var(--text-primary);
    background: var(--bg-main);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
  }

  .field input:focus {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }

  .field small {
    color: var(--text-muted);
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }

  .modal-actions button {
    padding: 7px 14px;
    font-size: calc(13px * var(--ui-scale, 1));
    border: 1px solid var(--border-strong);
    background: var(--bg-btn);
  }

  .modal-actions .primary-btn {
    background: var(--accent);
    border-color: transparent;
  }
</style>
