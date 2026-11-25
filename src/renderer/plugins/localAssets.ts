import type { Plugin } from 'carta-md';
import { ASSET_SCHEME } from '../../shared/ipc.js';

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** True for URLs that point at something other than a local relative/absolute path. */
function isNonLocal(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//') || src.startsWith('#');
}

/** Resolves a Markdown image src against the note's directory into an asset-protocol URL. */
export function resolveAssetUrl(src: string, baseDir: string): string | null {
  if (!src || isNonLocal(src)) return null;
  try {
    const base = `file://${encodeURI(baseDir.replace(/\/+$/, ''))}/`;
    const resolved = new URL(src, base);
    return `${ASSET_SCHEME}://local${resolved.pathname}`;
  } catch {
    return null;
  }
}

function rewriteImages(node: HastNode, baseDir: string): void {
  if (node.type === 'element' && node.tagName === 'img' && node.properties) {
    const src = node.properties.src;
    if (typeof src === 'string') {
      const rewritten = resolveAssetUrl(src, baseDir);
      if (rewritten) node.properties.src = rewritten;
    }
  }
  for (const child of node.children ?? []) rewriteImages(child, baseDir);
}

/**
 * Rewrites relative image sources to the asset protocol so they load from the
 * directory of the note being rendered.
 */
export function localAssetsPlugin(getBaseDir: () => string | null): Plugin {
  return {
    transformers: [
      {
        execution: 'sync',
        type: 'rehype',
        transform({ processor }) {
          processor.use(() => (tree: HastNode) => {
            const baseDir = getBaseDir();
            if (baseDir) rewriteImages(tree, baseDir);
          });
        }
      }
    ]
  };
}
