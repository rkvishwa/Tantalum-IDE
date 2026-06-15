import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AlertTriangle, CaseSensitive, Check, FileText, FolderOpen, LoaderCircle, Regex, Search, X } from 'lucide-react';

import type {
  WorkspaceReplaceChangedFile,
  WorkspaceReplacePreviewFile,
  WorkspaceSearchMode,
  WorkspaceSearchRequest,
  WorkspaceSearchResult,
  WorkspaceSearchStats,
} from '@/types/electron';

import { useConfirm } from './ConfirmProvider';

type WorkspaceSearchPopupProps = {
  open: boolean;
  workspacePath: string | null;
  dirtyFilePaths: string[];
  onClose: () => void;
  onOpenResult: (result: WorkspaceSearchResult) => Promise<void> | void;
  onReplaceApplied: (changedFiles: WorkspaceReplaceChangedFile[]) => void;
  onNotify: (
    message: string,
    level: 'success' | 'error' | 'info',
    actions?: Array<{ label: string; onSelect: () => void }>,
  ) => void;
};

type ReplacePreviewState = {
  files: WorkspaceReplacePreviewFile[];
  totalMatches: number;
  blockedPaths: string[];
};

const MODES: Array<{ id: WorkspaceSearchMode; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'files', label: 'Files' },
  { id: 'folders', label: 'Folders' },
  { id: 'text', label: 'Text' },
];

function fileNameFromPath(filePath: string) {
  return filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
}

function resultIcon(result: WorkspaceSearchResult) {
  if (result.type === 'folder') {
    return <FolderOpen size={15} />;
  }

  return <FileText size={15} />;
}

function buildRequest(
  query: string,
  mode: WorkspaceSearchMode,
  replace: string,
  useRegex: boolean,
  matchCase: boolean,
  wholeWord: boolean,
  includeGlob: string,
  excludeGlob: string,
  dirtyFilePaths: string[],
): WorkspaceSearchRequest {
  return {
    query,
    mode,
    replace,
    useRegex,
    matchCase,
    wholeWord,
    includeGlob,
    excludeGlob,
    blockedPaths: dirtyFilePaths,
    maxResults: 300,
  };
}

function formatStats(stats: WorkspaceSearchStats | null, truncated: boolean) {
  if (!stats) {
    return '';
  }

  const parts = [`${stats.totalResults} result${stats.totalResults === 1 ? '' : 's'}`];
  if (stats.textResults > 0) {
    parts.push(`${stats.textResults} text`);
  }
  if (stats.fileResults > 0) {
    parts.push(`${stats.fileResults} files`);
  }
  if (stats.folderResults > 0) {
    parts.push(`${stats.folderResults} folders`);
  }
  if (truncated) {
    parts.push('truncated');
  }

  return parts.join(' / ');
}

function renderPreview(result: WorkspaceSearchResult) {
  if (!result.preview || !result.column || !result.endColumn) {
    return null;
  }

  const start = Math.max(0, result.column - 1);
  const end = Math.max(start, result.endColumn - 1);
  const before = result.preview.slice(0, start);
  const match = result.preview.slice(start, end);
  const after = result.preview.slice(end);

  return (
    <code className="workspace-search-preview">
      {before}
      <mark>{match}</mark>
      {after}
    </code>
  );
}

export function WorkspaceSearchPopup({
  open,
  workspacePath,
  dirtyFilePaths,
  onClose,
  onOpenResult,
  onReplaceApplied,
  onNotify,
}: WorkspaceSearchPopupProps) {
  const { confirm } = useConfirm();
  const [query, setQuery] = useState('');
  const [replace, setReplace] = useState('');
  const [mode, setMode] = useState<WorkspaceSearchMode>('all');
  const [useRegex, setUseRegex] = useState(false);
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [includeGlob, setIncludeGlob] = useState('');
  const [excludeGlob, setExcludeGlob] = useState('');
  const [results, setResults] = useState<WorkspaceSearchResult[]>([]);
  const [stats, setStats] = useState<WorkspaceSearchStats | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [error, setError] = useState('');
  const [searching, setSearching] = useState(false);
  const [replacePreview, setReplacePreview] = useState<ReplacePreviewState | null>(null);
  const [previewingReplace, setPreviewingReplace] = useState(false);
  const [applyingReplace, setApplyingReplace] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open || !workspacePath) {
      return;
    }

    setReplacePreview(null);
    setActiveIndex(0);

    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setResults([]);
      setStats(null);
      setTruncated(false);
      setError('');
      setSearching(false);
      return;
    }

    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setSearching(true);
      setError('');

      const request = buildRequest(trimmedQuery, mode, '', useRegex, matchCase, wholeWord, includeGlob, excludeGlob, []);
      const response = await window.tantalum.workspace.search(request);

      if (cancelled) {
        return;
      }

      setSearching(false);
      if (!response.success) {
        setResults([]);
        setStats(null);
        setTruncated(false);
        setError(response.error);
        return;
      }

      setResults(response.results);
      setStats(response.stats);
      setTruncated(response.truncated);
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [excludeGlob, includeGlob, matchCase, mode, open, query, useRegex, wholeWord, workspacePath]);

  if (!open) {
    return null;
  }

  const selectedResult = results[activeIndex] ?? null;
  const searchSummary = formatStats(stats, truncated);
  const canReplace = Boolean(query.trim()) && (mode === 'all' || mode === 'text');
  const blockedDirtyFiles = replacePreview?.blockedPaths ?? [];

  const openSelectedResult = async () => {
    if (!selectedResult) {
      return;
    }

    await onOpenResult(selectedResult);
    onClose();
  };

  const handleKeyDown = async (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => Math.min(results.length - 1, current + 1));
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      await openSelectedResult();
    }
  };

  const previewReplace = async () => {
    if (!canReplace) {
      return;
    }

    setPreviewingReplace(true);
    setError('');

    const response = await window.tantalum.workspace.previewReplace(
      buildRequest(query.trim(), 'text', replace, useRegex, matchCase, wholeWord, includeGlob, excludeGlob, dirtyFilePaths),
    );

    setPreviewingReplace(false);
    if (!response.success) {
      setReplacePreview(null);
      setError(response.error);
      return;
    }

    setReplacePreview({
      files: response.files,
      totalMatches: response.totalMatches,
      blockedPaths: response.blockedPaths,
    });
  };

  const applyReplace = async () => {
    if (!replacePreview || replacePreview.totalMatches === 0 || blockedDirtyFiles.length > 0) {
      return;
    }

    const confirmed = await confirm({
      message: `Replace ${replacePreview.totalMatches} match${replacePreview.totalMatches === 1 ? '' : 'es'} across ${replacePreview.files.length} file${replacePreview.files.length === 1 ? '' : 's'}?`,
      tone: 'warning',
      confirmLabel: 'Replace all',
    });
    if (!confirmed) {
      return;
    }

    setApplyingReplace(true);
    setError('');

    const response = await window.tantalum.workspace.applyReplace(
      buildRequest(query.trim(), 'text', replace, useRegex, matchCase, wholeWord, includeGlob, excludeGlob, dirtyFilePaths),
    );

    setApplyingReplace(false);
    if (!response.success) {
      setError(response.error);
      return;
    }

    onReplaceApplied(response.changedFiles);
    setReplacePreview(null);
    onNotify(`Replaced ${response.totalReplacements} match${response.totalReplacements === 1 ? '' : 'es'}.`, 'success');
  };

  return (
    <div className="workspace-search-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="workspace-search-dialog" role="dialog" aria-modal="true" aria-label="Project Space search" onKeyDown={(event) => void handleKeyDown(event)}>
        <div className="workspace-search-head">
          <div className="workspace-search-head-top">
            <strong className="workspace-search-title">Project Space search</strong>
            <button className="icon-button workspace-search-close" type="button" onClick={onClose} aria-label="Close Project Space search">
              <X size={16} />
            </button>
          </div>
          <div className="workspace-search-toolbar">
            <Search size={17} />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search files, folders, or text"
              aria-label="Search Project Space"
            />
            {searching ? <LoaderCircle size={16} className="spin" /> : null}
            <select className="workspace-search-mode-select" value={mode} onChange={(event) => setMode(event.target.value as WorkspaceSearchMode)} aria-label="Search mode">
              {MODES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <div className="workspace-search-toggles" aria-label="Search options">
              <button className={useRegex ? 'active' : ''} type="button" onClick={() => setUseRegex((current) => !current)} title="Use regex">
                <Regex size={14} />
              </button>
              <button className={matchCase ? 'active' : ''} type="button" onClick={() => setMatchCase((current) => !current)} title="Match case">
                <CaseSensitive size={15} />
              </button>
              <button className={wholeWord ? 'active' : ''} type="button" onClick={() => setWholeWord((current) => !current)} title="Match whole word">
                W
              </button>
            </div>
          </div>
        </div>

        <details className="workspace-search-filters">
          <summary>Filters</summary>
          <div>
            <label>
              <span>Include</span>
              <input value={includeGlob} onChange={(event) => setIncludeGlob(event.target.value)} placeholder="all files" />
            </label>
            <label>
              <span>Exclude</span>
              <input value={excludeGlob} onChange={(event) => setExcludeGlob(event.target.value)} placeholder="optional" />
            </label>
          </div>
        </details>

        {canReplace ? (
          <div className="workspace-search-replace">
            <input value={replace} onChange={(event) => setReplace(event.target.value)} placeholder="Replace with" aria-label="Replace with" />
            <button type="button" onClick={() => void previewReplace()} disabled={previewingReplace || !query.trim()}>
              {previewingReplace ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
              Preview
            </button>
            <button type="button" onClick={() => void applyReplace()} disabled={applyingReplace || !replacePreview || replacePreview.totalMatches === 0 || blockedDirtyFiles.length > 0}>
              {applyingReplace ? <LoaderCircle size={14} className="spin" /> : null}
              Replace All
            </button>
          </div>
        ) : null}

        {error ? (
          <div className="inline-banner inline-banner-error">
            <AlertTriangle size={15} />
            <span>{error}</span>
          </div>
        ) : null}

        {replacePreview ? (
          <div className={`inline-banner ${blockedDirtyFiles.length > 0 ? 'inline-banner-warning' : 'inline-banner-success'}`}>
            {blockedDirtyFiles.length > 0 ? <AlertTriangle size={15} /> : <Check size={15} />}
            <span>
              {blockedDirtyFiles.length > 0
                ? `${blockedDirtyFiles.length} dirty open file${blockedDirtyFiles.length === 1 ? '' : 's'} must be saved or closed before replacing.`
                : `${replacePreview.totalMatches} replacement${replacePreview.totalMatches === 1 ? '' : 's'} ready across ${replacePreview.files.length} file${replacePreview.files.length === 1 ? '' : 's'}.`}
            </span>
          </div>
        ) : null}

        <div className="workspace-search-results" role="listbox" aria-label="Project Space search results">
          {!query.trim() ? (
            <div className="workspace-search-empty">Type to search the Project Space.</div>
          ) : results.length === 0 && !searching && !error ? (
            <div className="workspace-search-empty">No matches found.</div>
          ) : (
            results.map((result, index) => (
              <button
                key={result.id}
                className={`workspace-search-result ${index === activeIndex ? 'active' : ''}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => {
                  void onOpenResult(result);
                  onClose();
                }}
              >
                <span className="workspace-search-result-icon">{resultIcon(result)}</span>
                <span className="workspace-search-result-copy">
                  <strong>
                    {result.type === 'text' && result.lineNumber ? `${result.name}:${result.lineNumber}` : result.name}
                    <small>{result.type}</small>
                  </strong>
                  <span>{result.relativePath}</span>
                  {renderPreview(result)}
                </span>
              </button>
            ))
          )}
        </div>

        {replacePreview && replacePreview.files.length > 0 ? (
          <div className="workspace-search-replace-preview">
            {replacePreview.files.slice(0, 5).map((file) => (
              <article key={file.path}>
                <strong>
                  {fileNameFromPath(file.path)}
                  <span>{file.matchCount} match{file.matchCount === 1 ? '' : 'es'}</span>
                </strong>
                <small>{file.relativePath}</small>
                {file.previews.slice(0, 2).map((preview) => (
                  <code key={`${file.path}:${preview.lineNumber}:${preview.column}`}>
                    {preview.lineNumber}: {preview.before}
                    <span>{' -> '}{preview.after}</span>
                  </code>
                ))}
              </article>
            ))}
          </div>
        ) : null}

        <div className="workspace-search-footer">
          <span>{searchSummary}</span>
          <span>Enter opens / Esc closes / Ctrl Shift F</span>
        </div>
      </div>
    </div>
  );
}
