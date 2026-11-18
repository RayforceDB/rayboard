import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const KEYWORDS = /^(?:as|async|await|break|case|catch|class|const|continue|def|default|delete|do|else|enum|export|extends|finally|fn|for|from|function|if|implements|import|in|instanceof|interface|let|match|new|not|of|or|package|private|protected|public|raise|return|static|struct|switch|this|throw|try|type|typeof|use|using|var|void|while|with|yield|select|where|group|by|order|insert|update|into|values|join|on|and|union|create|table)$/;
const LITERALS = /^(?:true|false|null|nil|None|True|False|undefined|NaN|Infinity)$/;
/** Lexical coloring, not HTML injection or evaluation of untrusted code. */
export function highlightCode(text: string) {
  const pattern = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\b(?:0[xob][\da-f]+|\d+(?:\.\d+)?)\b|\b[A-Za-z_$][\w$-]*\b)/gi;
  return text.split(pattern).map((part, i) => {
    let kind = 'syntax-plain';
    if (/^(?:\/\/|\/\*|#)/.test(part)) kind = 'syntax-comment';
    else if (/^(?:`|"|')/.test(part)) kind = 'syntax-string';
    else if (LITERALS.test(part)) kind = 'syntax-literal';
    else if (KEYWORDS.test(part)) kind = 'syntax-keyword';
    else if (/^(?:0[xob]|\d)/i.test(part)) kind = 'syntax-number';
    return <span key={i} className={kind}>{part}</span>;
  });
}

/** An image the board keeps: a path on this origin, never a URL of another. */
export const OWN_IMAGE = /^\/api\/images\/[a-f0-9]{48}$/;

/** Markdown, not HTML: board text is untrusted, and raw HTML is never rendered. */
export function Prose({ children, className = '' }: { children: string; className?: string }) {
  return <div className={`prose ${className}`}>
    <Markdown remarkPlugins={[remarkGfm]} components={{
      // A link whose address was refused as unsafe (javascript:, data:…) stays as plain text, not an anchor to the page itself.
      a: ({ children, href, title }) => href ? <a href={href} title={title} target="_blank" rel="noreferrer noopener nofollow">{children}</a> : <span>{children}</span>,
      // An image from elsewhere would be fetched by every reader's browser the moment the message is shown: a
      // tracker or a probe of their network. It becomes a link they may choose to open. Only an image the board
      // itself keeps, pasted here (T-447), is shown in place.
      img: ({ src, alt }) => typeof src === 'string' && OWN_IMAGE.test(src)
        ? <a className="pasted-image" href={src} target="_blank" rel="noreferrer noopener"><img src={src} alt={alt ?? ''} loading="lazy" /></a>
        : typeof src === 'string' && src !== '' ? <a className="image-link" href={src} target="_blank" rel="noreferrer noopener nofollow">{alt || src}</a> : <span>{alt}</span>,
      code: ({ className, children }) => {
        const source = String(children ?? '').replace(/\n$/, '');
        return className ? <code className={className} data-language={className.replace(/^language-/, '')}>{highlightCode(source)}</code> : <code>{children}</code>;
      },
    }}>{children}</Markdown>
  </div>;
}
