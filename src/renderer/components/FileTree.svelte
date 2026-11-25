<script lang="ts">
  import FileTree from './FileTree.svelte';
  import type { FileNode } from '../../shared/ipc.js';

  interface Props {
    nodes: FileNode[];
    activeFilePath: string | null;
    collapsed: ReadonlySet<string>;
    depth?: number;
    onSelectFile: (filePath: string) => void;
    onToggleDir: (dirPath: string) => void;
  }

  let { nodes, activeFilePath, collapsed, depth = 0, onSelectFile, onToggleDir }: Props = $props();

  function displayName(node: FileNode): string {
    if (node.kind === 'file') {
      return node.name.replace(/\.(md|markdown)$/i, '');
    }
    return node.name;
  }
</script>

<ul class="tree-list" role={depth === 0 ? 'tree' : 'group'}>
  {#each nodes as node (node.path)}
    {@const isCollapsed = collapsed.has(node.path)}
    <li class="tree-item" role="treeitem" aria-expanded={node.kind === 'directory' ? !isCollapsed : undefined} aria-selected={node.path === activeFilePath}>
      {#if node.kind === 'directory'}
        <button
          type="button"
          class="tree-row directory"
          style:padding-left={`${12 + depth * 16}px`}
          onclick={() => onToggleDir(node.path)}
          title={node.path}
        >
          <span class="chevron" aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
          <span class="label">{node.name}</span>
        </button>
        {#if !isCollapsed && node.children && node.children.length > 0}
          <FileTree
            nodes={node.children}
            {activeFilePath}
            {collapsed}
            depth={depth + 1}
            {onSelectFile}
            {onToggleDir}
          />
        {/if}
      {:else}
        <button
          type="button"
          class="tree-row file"
          class:active={node.path === activeFilePath}
          style:padding-left={`${28 + depth * 16}px`}
          onclick={() => onSelectFile(node.path)}
          title={node.path}
        >
          <span class="label">{displayName(node)}</span>
        </button>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .tree-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .tree-row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
    border-radius: 0;
    text-align: left;
    color: var(--text-primary);
    font-size: calc(14px * var(--ui-scale, 1));
    line-height: 1.35;
  }

  .tree-row.directory {
    color: var(--text-secondary);
    font-weight: 500;
  }

  .tree-row:hover {
    background: var(--bg-sidebar-hover);
  }

  .tree-row.active {
    background: var(--bg-sidebar-active);
    color: #ffffff;
    font-weight: 500;
  }

  .chevron {
    width: calc(12px * var(--ui-scale, 1));
    flex-shrink: 0;
    text-align: center;
    font-size: calc(11px * var(--ui-scale, 1));
    color: var(--text-muted);
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
