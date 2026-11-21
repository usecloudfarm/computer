/** A file's contents, shown over the thread so the panel keeps its width. */
export function FileViewer({
  path,
  content,
  onClose,
}: {
  path: string;
  content: string | null;
  onClose: () => void;
}) {
  return (
    <div className="viewer" role="dialog" aria-label={path}>
      <div className="viewer__head">
        <code className="viewer__path">{path}</code>
        <button className="viewer__close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {content === null ? (
        <p className="viewer__loading">loading…</p>
      ) : (
        <pre className="viewer__body">{content}</pre>
      )}
    </div>
  );
}
