import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import hljs from 'highlight.js';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { resolveImage, ReaderError } from './paths.js';

const domWindow = new JSDOM('').window;
const purify = createDOMPurify(domWindow);

const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a', 'em', 'strong', 'del', 's', 'code', 'pre', 'span', 'small',
  'blockquote', 'ul', 'ol', 'li', 'div',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'input', 'img', 'sup', 'sub', 'kbd', 'mark',
];

const ALLOWED_ATTR = [
  'id', 'class', 'href', 'title', 'target', 'rel',
  'src', 'alt', 'width', 'height', 'loading', 'decoding',
  'type', 'checked', 'disabled', 'start', 'align',
  'colspan', 'rowspan', 'data-lang', 'data-local-link', 'data-share-asset',
  'role', 'aria-label', 'aria-hidden',
];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function plainTextFromInline(token) {
  if (!token || !Array.isArray(token.children)) return token?.content || '';
  return token.children
    .map((child) => {
      if (child.type === 'image') return child.content || '';
      if (child.type === 'softbreak' || child.type === 'hardbreak') return ' ';
      return child.content || '';
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugify(text) {
  const slug = String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&[a-z0-9#]+;/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'section';
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: false,
  quotes: '“”‘’',
  highlight: false,
});

md.use(taskLists, { enabled: false, label: false });

md.core.ruler.push('modu_unique_heading_ids', (state) => {
  const used = new Set();
  for (let index = 0; index < state.tokens.length; index += 1) {
    const token = state.tokens[index];
    if (token.type !== 'heading_open') continue;
    const inline = state.tokens[index + 1];
    const base = slugify(plainTextFromInline(inline));
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    token.attrSet('id', id);
  }
});

const defaultLinkOpen = md.renderer.rules.link_open
  || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const href = token.attrGet('href') || '';

  if (/^https?:\/\//i.test(href)) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
    token.attrSet('class', 'external-link');
  } else if (/^mailto:/i.test(href)) {
    token.attrSet('class', 'external-link');
  } else if (href.startsWith('#')) {
    token.attrSet('class', 'in-doc-link');
  } else {
    // Relative links are not followed automatically. Opening a different
    // document is always an explicit action in the reader.
    token.attrSet('href', '#');
    token.attrSet('data-local-link', href);
    token.attrSet('class', 'local-doc-link');
    token.attrSet('title', `本地链接：${href}（请通过左侧路径打开）`);
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx];
  const info = (token.info || '').trim();
  const language = info.split(/\s+/)[0] || '';
  const code = token.content;
  let highlighted;
  if (language && hljs.getLanguage(language)) {
    highlighted = hljs.highlight(code, {
      language,
      ignoreIllegals: true,
    }).value;
  } else {
    highlighted = escapeHtml(code);
  }
  const label = language || 'text';
  return `<pre class="md-code" data-lang="${escapeHtml(label)}"><code class="hljs">${highlighted}</code></pre>\n`;
};

md.renderer.rules.table_open = () => '<div class="md-table-wrap"><table>\n';
md.renderer.rules.table_close = () => '</table></div>\n';

md.renderer.rules.image = (tokens, idx, options, env) => {
  const token = tokens[idx];
  const rawSrc = token.attrGet('src') || '';
  const alt = token.content || '';
  const title = token.attrGet('title') || '';
  let asset;
  try {
    asset = resolveImage(env.doc, rawSrc);
  } catch (error) {
    const detail = error instanceof ReaderError ? error.message : '图片不可读取。';
    return `<span class="md-image-blocked" role="img" aria-label="${escapeHtml(alt || '图片未显示')}">`
      + `<span class="md-image-blocked-title">图片未显示</span>`
      + `<small>${escapeHtml(alt || detail)} · 仅加载文档目录内的本地图片</small>`
      + '</span>';
  }

  const caption = alt
    ? `<span class="md-figcaption">${escapeHtml(alt)}</span>`
    : '';
  const titleAttribute = title ? ` title="${escapeHtml(title)}"` : '';

  // The LAN page never receives a usable image URL: it has to fetch bytes with
  // the token header and turn them into a blob URL. That keeps the share token
  // out of URLs, Referer headers, and browser history.
  if (env.assetMode === 'lan') {
    return `<span class="md-figure"><img data-share-asset="${escapeHtml(asset.relativePath)}"`
      + ` alt="${escapeHtml(alt)}"${titleAttribute} loading="lazy" decoding="async" class="md-image">`
      + `${caption}</span>`;
  }

  const assetUrl = `/api/asset?token=${encodeURIComponent(env.token)}`
    + `&p=${encodeURIComponent(asset.relativePath)}`
    + `&v=${Math.round(asset.mtimeMs)}`;
  return `<span class="md-figure"><img src="${escapeHtml(assetUrl)}" alt="${escapeHtml(alt)}"`
    + `${titleAttribute} loading="lazy" decoding="async" class="md-image">${caption}</span>`;
};

const CLEAN_CONFIG = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'button', 'textarea', 'select'],
  FORBID_ATTR: ['style', 'srcset', 'formaction', 'xlink:href'],
  KEEP_CONTENT: true,
};

export function renderMarkdown(source, doc, token, options = {}) {
  const env = { doc, token, assetMode: options.assetMode === 'lan' ? 'lan' : 'local' };
  const tokens = md.parse(source, env);

  const headings = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const tokenItem = tokens[index];
    if (tokenItem.type === 'heading_open') {
      headings.push({
        level: Number(tokenItem.tag.slice(1)),
        id: tokenItem.attrGet('id'),
        text: plainTextFromInline(tokens[index + 1]),
      });
    }
  }

  const rawHtml = md.renderer.render(tokens, md.options, env);
  const html = purify.sanitize(rawHtml, CLEAN_CONFIG);
  return { html, headings };
}
