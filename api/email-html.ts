import sanitizeHtml from 'sanitize-html'

// Email HTML uses inline styles and tables; executable content and URL/file access stay forbidden.
export function cleanEmailHtml(html: string) {
  return sanitizeHtml(html, {
    allowedTags: ['p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'hr', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'img'],
    allowedAttributes: { '*': ['style'], a: ['href', 'title'], img: ['src', 'alt', 'width', 'height'], table: ['cellpadding', 'cellspacing', 'border', 'width', 'role'], td: ['width', 'colspan', 'rowspan', 'valign'], th: ['colspan', 'rowspan'] },
    allowedSchemes: ['https', 'http', 'mailto', 'tel'], allowedSchemesByTag: { img: ['https'] }, allowProtocolRelative: false,
    allowedStyles: { '*': {
      color: [/^#[0-9a-f]{3,8}$/i, /^[a-z]+$/i, /^rgb\(\s*\d{1,3},\s*\d{1,3},\s*\d{1,3}\s*\)$/],
      'background-color': [/^#[0-9a-f]{3,8}$/i, /^[a-z]+$/i],
      'font-family': [/^[a-z0-9 ,'-]+$/i], 'font-size': [/^\d{1,3}(px|pt)$/], 'font-weight': [/^(normal|bold|[1-9]00)$/],
      'text-align': [/^(left|right|center)$/], 'text-decoration': [/^(none|underline|line-through)$/],
      'line-height': [/^\d{1,2}(\.\d{1,2})?(px|%)?$/],
      padding: [/^\d{1,3}px( \d{1,3}px){0,3}$/], margin: [/^\d{1,3}px( \d{1,3}px){0,3}$/],
      width: [/^\d{1,4}(px|%)$/], height: [/^\d{1,4}px$/], 'border-collapse': [/^collapse$/],
      'border-left': [/^\dpx solid #[0-9a-f]{3,8}$/i], 'vertical-align': [/^(top|middle|bottom)$/],
    } }, nestingLimit: 30,
  })
}
export function emailPlainText(html: string) {
  return sanitizeHtml(html.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(p|div|li|tr|h[123]|blockquote)>/gi, '\n'), { allowedTags: [], allowedAttributes: {} }).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff))).trim()
}
