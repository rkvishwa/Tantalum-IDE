import { Fragment, type ReactNode } from 'react';
import { Terminal } from 'lucide-react';

type MarkdownRendererProps = {
  content: string;
};

type Block =
  | { type: 'code'; language: string; content: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'paragraph'; content: string };

const COMMAND_LANGUAGE_LABELS: Record<string, string> = {
  bash: 'Bash',
  cmd: 'Command Prompt',
  command: 'Command Prompt',
  'command prompt': 'Command Prompt',
  console: 'Terminal',
  powershell: 'PowerShell',
  ps: 'PowerShell',
  ps1: 'PowerShell',
  shell: 'Terminal',
  sh: 'Shell',
  terminal: 'Terminal',
  zsh: 'Zsh',
};

function normalizeLanguage(language: string) {
  return language.trim().toLowerCase();
}

function commandLanguageLabel(language: string) {
  return COMMAND_LANGUAGE_LABELS[normalizeLanguage(language)];
}

function renderInline(content: string) {
  const parts: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;

  for (const match of content.matchAll(pattern)) {
    const token = match[0];
    const index = match.index ?? 0;

    if (index > lastIndex) {
      parts.push(content.slice(lastIndex, index));
    }

    if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(<code key={`${index}-code`}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**') && token.endsWith('**')) {
      parts.push(<strong key={`${index}-strong`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('[')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        parts.push(
          <a key={`${index}-link`} href={linkMatch[2]} target="_blank" rel="noreferrer">
            {linkMatch[1]}
          </a>,
        );
      } else {
        parts.push(token);
      }
    }

    lastIndex = index + token.length;
  }

  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }

  return parts.length > 0 ? parts : content;
}

function parseBlocks(markdown: string) {
  const lines = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const contentLines: string[] = [];
      index += 1;

      while (index < lines.length && !lines[index].startsWith('```')) {
        contentLines.push(lines[index]);
        index += 1;
      }

      if (index < lines.length) {
        index += 1;
      }

      blocks.push({ type: 'code', language, content: contentLines.join('\n') });
      continue;
    }

    const isOrdered = /^\d+\.\s+/.test(line);
    const isUnordered = /^[-*]\s+/.test(line);

    if (isOrdered || isUnordered) {
      const items: string[] = [];
      const matcher = isOrdered ? /^\d+\.\s+/ : /^[-*]\s+/;

      while (index < lines.length && matcher.test(lines[index])) {
        items.push(lines[index].replace(matcher, ''));
        index += 1;
      }

      blocks.push({ type: 'list', ordered: isOrdered, items });
      continue;
    }

    const paragraphLines = [line];
    index += 1;

    while (index < lines.length && lines[index].trim() && !lines[index].startsWith('```') && !/^[-*]\s+/.test(lines[index]) && !/^\d+\.\s+/.test(lines[index])) {
      paragraphLines.push(lines[index]);
      index += 1;
    }

    blocks.push({ type: 'paragraph', content: paragraphLines.join(' ') });
  }

  return blocks;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const blocks = parseBlocks(content);

  return (
    <div className="markdown-renderer">
      {blocks.map((block, index) => {
        if (block.type === 'code') {
          const commandLabel = commandLanguageLabel(block.language);
          const blockClassName = commandLabel ? 'markdown-code-block markdown-command-block' : 'markdown-code-block';

          return (
            <pre key={`code-${index}`} className={blockClassName}>
              {block.language ? (
                <span className="markdown-code-language">
                  {commandLabel ? <Terminal className="markdown-command-icon" size={12} aria-hidden="true" /> : null}
                  {commandLabel ?? block.language}
                </span>
              ) : null}
              <code>{block.content}</code>
            </pre>
          );
        }

        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag key={`list-${index}`}>
              {block.items.map((item, itemIndex) => (
                <li key={`item-${index}-${itemIndex}`}>{renderInline(item)}</li>
              ))}
            </ListTag>
          );
        }

        const inline = renderInline(block.content);
        return (
          <p key={`paragraph-${index}`}>
            {Array.isArray(inline) ? <Fragment>{inline}</Fragment> : inline}
          </p>
        );
      })}
    </div>
  );
}
