type MermaidApi = {
  initialize(config: Record<string, unknown>): void;
  render(id: string, source: string): Promise<{ svg: string }>;
};

type DiagramRoot = {
  querySelectorAll(selector: string): ArrayLike<DiagramHost>;
};

type DiagramHost = {
  attributes?: ArrayLike<{ name: string; value: string }>;
  tagName?: string;
  outerHTML?: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  remove(): void;
  appendChild(node: unknown): unknown;
  querySelectorAll(selector: string): ArrayLike<DiagramHost>;
  querySelector(selector: string): SourceNode | null;
  textContent: string | null;
  innerHTML: string;
  className: string;
  dataset: Record<string, string>;
  isConnected?: boolean;
};

type SourceNode = {
  textContent: string | null;
};

type DocumentLike = {
  documentElement: unknown;
  createElement(tagName: string): DiagramHost & {
    setAttribute(name: string, value: string): void;
  };
};

type GlobalWithDocument = typeof globalThis & {
  document?: DocumentLike;
  getComputedStyle?: (element: unknown) => {
    getPropertyValue(property: string): string;
  };
  mermaid?: MermaidApi;
};

const globalObject = globalThis as GlobalWithDocument;
// Mermaid's self-contained browser distribution is emitted as a separate local
// script and loaded before this bridge. Keeping it outside the webpack module
// wrapper preserves the distribution's global initialization contract.
const mermaidRuntime = globalObject.mermaid;
if (!mermaidRuntime) {
  throw new Error('The bundled Mermaid runtime did not initialize.');
}
const mermaid: MermaidApi = mermaidRuntime;
let renderSequence = 0;

function cssVariable(name: string, fallback: string): string {
  try {
    const document = globalObject.document;
    const getComputedStyle = globalObject.getComputedStyle;
    if (document && getComputedStyle) {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      if (value) {
        return value;
      }
    }
  } catch {
    // Mermaid still has usable fallback colors in reduced DOM test hosts.
  }
  return fallback;
}

function initializeMermaid(): void {
  const flowchartFill = cssVariable('--vscode-button-secondaryBackground', '#3a3d41');
  const flowchartText = cssVariable('--vscode-button-secondaryForeground', '#f0f0f0');
  const flowchartBorder = cssVariable('--vscode-focusBorder', '#007acc');
  const flowchartLine = cssVariable('--vscode-descriptionForeground', '#c5c5c5');
  const edgeLabelBackground = cssVariable('--vscode-editorWidget-background', '#252526');

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    htmlLabels: false,
    theme: 'base',
    themeVariables: {
      background: edgeLabelBackground,
      primaryColor: flowchartFill,
      primaryTextColor: flowchartText,
      primaryBorderColor: flowchartBorder,
      lineColor: flowchartLine,
      secondaryColor: cssVariable('--vscode-editor-background', '#1e1e1e'),
      tertiaryColor: edgeLabelBackground,
      mainBkg: flowchartFill,
      nodeBorder: flowchartBorder,
      nodeTextColor: flowchartText,
      defaultLinkColor: flowchartLine,
      edgeLabelBackground,
      fontFamily: cssVariable('--vscode-font-family', 'Arial, sans-serif'),
    },
    flowchart: {
      useMaxWidth: true,
    },
    sequence: {
      useMaxWidth: true,
    },
  });
}

function hasUnsafeStyleContent(styleText: string): boolean {
  if (/@import|expression\s*\(|javascript\s*:/i.test(styleText)) {
    return true;
  }

  const urls = styleText.match(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi) || [];
  return urls.some((url) => !/^url\s*\(\s*['"]?\s*#/i.test(url));
}

function sanitizeSvg(svg: string, styleNonce: string): string {
  const document = globalObject.document;
  if (!document) {
    throw new Error('A document is required to render Mermaid diagrams.');
  }

  const template = document.createElement('template') as DiagramHost & {
    content: { querySelector(selector: string): DiagramHost | null };
  };
  template.innerHTML = svg;
  const root = template.content.querySelector('svg');
  if (!root) {
    throw new Error('Mermaid did not produce an SVG diagram.');
  }

  const dangerousTags = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'image', 'link']);
  const elements = root.querySelectorAll('*');
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    if (!element) {
      continue;
    }
    const tagName = (element.tagName || '').toLowerCase();
    if (dangerousTags.has(tagName)) {
      element.remove();
      continue;
    }
    const attributes = element.attributes;
    if (attributes) {
      for (let attributeIndex = attributes.length - 1; attributeIndex >= 0; attributeIndex -= 1) {
        const attribute = attributes[attributeIndex];
        if (!attribute) {
          continue;
        }
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim();
        const unsafeEvent = name.startsWith('on');
        const unsafeUrl = ['src', 'action', 'formaction'].includes(name) ||
          (['href', 'xlink:href'].includes(name) && !value.startsWith('#'));
        const unsafeStyle = name === 'style' && hasUnsafeStyleContent(value);
        if (unsafeEvent || unsafeUrl || unsafeStyle) {
          element.removeAttribute(attribute.name);
        }
      }
    }
    if (tagName === 'style') {
      const styleText = element.textContent || '';
      if (hasUnsafeStyleContent(styleText)) {
        element.remove();
      } else if (styleNonce) {
        element.setAttribute('nonce', styleNonce);
      }
    }
  }

  if (!root.outerHTML) {
    throw new Error('Mermaid produced an empty SVG diagram.');
  }
  return root.outerHTML;
}

function sourceFor(host: DiagramHost): string {
  return host.querySelector('.modal-mermaid-source')?.textContent || '';
}

function appendFallback(host: DiagramHost, source: string, message: string): void {
  const document = globalObject.document;
  if (!document) {
    return;
  }
  host.textContent = '';
  host.dataset.mermaidState = 'error';
  host.removeAttribute('aria-busy');
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', 'Mermaid diagram unavailable');

  const notice = document.createElement('div');
  notice.className = 'modal-mermaid-message';
  notice.setAttribute('role', 'status');
  notice.textContent = message;
  host.appendChild(notice);

  const sourceNode = document.createElement('pre');
  sourceNode.className = 'modal-mermaid-source';
  sourceNode.setAttribute('aria-label', 'Mermaid source');
  sourceNode.textContent = source || 'No Mermaid source was provided.';
  host.appendChild(sourceNode);
}

function isDetached(host: DiagramHost): boolean {
  return host.isConnected === false;
}

async function renderOne(host: DiagramHost, styleNonce: string): Promise<void> {
  if (host.dataset.mermaidState === 'rendered' || isDetached(host)) {
    return;
  }
  const source = sourceFor(host);
  host.dataset.mermaidState = 'loading';
  host.setAttribute('aria-busy', 'true');
  try {
    const id = 'kanbanPilotMermaid' + String(++renderSequence);
    const result = await mermaid.render(id, source);
    const safeSvg = sanitizeSvg(result.svg, styleNonce);
    if (isDetached(host)) {
      return;
    }
    const document = globalObject.document;
    if (!document) {
      throw new Error('A document is required to render Mermaid diagrams.');
    }
    host.textContent = '';
    host.dataset.mermaidState = 'rendered';
    host.removeAttribute('aria-busy');
    host.setAttribute('role', 'img');
    host.setAttribute('aria-label', 'Mermaid diagram');
    const rendered = document.createElement('div');
    rendered.className = 'modal-mermaid-rendered';
    rendered.innerHTML = safeSvg;
    host.appendChild(rendered);
  } catch {
    if (isDetached(host)) {
      return;
    }
    appendFallback(host, source, 'Mermaid diagram could not be rendered. The source is shown below.');
  }
}

async function renderMermaidDiagrams(root: DiagramRoot, styleNonce = ''): Promise<void> {
  initializeMermaid();
  const hosts = root.querySelectorAll('[data-mermaid-diagram]');
  const renders: Promise<void>[] = [];
  for (let index = 0; index < hosts.length; index += 1) {
    const host = hosts[index];
    if (host) {
      renders.push(renderOne(host, styleNonce));
    }
  }
  await Promise.all(renders);
}

(globalObject as typeof globalObject & {
  kanbanPilotMermaid?: { render(root: DiagramRoot, styleNonce?: string): Promise<void> };
}).kanbanPilotMermaid = {
  render: renderMermaidDiagrams,
};
