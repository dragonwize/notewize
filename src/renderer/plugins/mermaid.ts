import mermaid from 'mermaid';
import type { Plugin } from 'carta-md';

interface MdastNode {
  type: string;
  lang?: string | null;
  value?: string;
  children?: MdastNode[];
  data?: Record<string, unknown>;
}

let mermaidInitialized = false;
let renderCounter = 0;

function ensureMermaidInitialized(): void {
  if (mermaidInitialized) return;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'strict',
    suppressErrorRendering: true,
    themeVariables: {
      darkMode: true,
      background: '#1c1c1c',
      primaryColor: '#2c2c2c',
      primaryTextColor: '#e6e6e6',
      primaryBorderColor: '#4a4a4a',
      lineColor: '#a0a0a0',
      secondaryColor: '#252525',
      tertiaryColor: '#1f1f1f'
    }
  });
  mermaidInitialized = true;
}

function visitMdast(node: MdastNode, visitor: (node: MdastNode) => void): void {
  visitor(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      visitMdast(child, visitor);
    }
  }
}

export function remarkMermaid() {
  return (tree: MdastNode): void => {
    visitMdast(tree, (node) => {
      if (node.type === 'code' && node.lang?.toLowerCase() === 'mermaid' && typeof node.value === 'string') {
        node.data = {
          ...node.data,
          hName: 'div',
          hProperties: {
            className: ['mermaid-diagram'],
            dataMermaid: encodeURIComponent(node.value)
          },
          hChildren: []
        };
      }
    });
  };
}

async function renderMermaidBlocks(container: HTMLElement): Promise<void> {
  const blocks = container.querySelectorAll<HTMLElement>(
    '.mermaid-diagram[data-mermaid]:not([data-mermaid-rendered])'
  );
  if (blocks.length === 0) return;

  ensureMermaidInitialized();

  for (const el of blocks) {
    const encoded = el.getAttribute('data-mermaid');
    const source = encoded ? decodeURIComponent(encoded).trim() : '';
    if (!source) {
      el.setAttribute('data-mermaid-rendered', 'empty');
      continue;
    }

    el.setAttribute('data-mermaid-rendered', 'pending');
    const id = `notewize-mermaid-${++renderCounter}`;

    try {
      const { svg, bindFunctions } = await mermaid.render(id, source);
      if (!el.isConnected) continue;
      el.innerHTML = svg;
      el.setAttribute('data-mermaid-rendered', 'true');
      bindFunctions?.(el);
    } catch (error) {
      document.getElementById(`d${id}`)?.remove();
      if (!el.isConnected) continue;
      el.setAttribute('data-mermaid-rendered', 'error');
      el.classList.add('mermaid-error');
      const message = error instanceof Error ? error.message : 'Invalid Mermaid diagram';
      el.textContent = `Mermaid diagram error: ${message}`;
    }
  }
}

export function mermaidPlugin(): Plugin {
  const scheduleRender = (carta: { renderer?: { container: HTMLDivElement } }): void => {
    setTimeout(() => {
      const container = carta.renderer?.container;
      if (container) {
        void renderMermaidBlocks(container);
      }
    }, 0);
  };

  return {
    transformers: [
      {
        execution: 'sync',
        type: 'remark',
        transform({ processor }) {
          processor.use(remarkMermaid);
        }
      }
    ],
    listeners: [
      [
        'carta-render',
        (event) => {
          scheduleRender(event.detail.carta);
        }
      ],
      [
        'carta-render-ssr',
        (event) => {
          scheduleRender(event.detail.carta);
        }
      ]
    ]
  };
}
