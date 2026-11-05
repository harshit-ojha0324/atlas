import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Upload, Trash2, Loader, FileText, Search, BookOpen, Check, CloudOff, X } from 'lucide-react';
import Stats from './Stats';
import api from '../services/api';
import { useCopy, useTheme } from '../theme';

const MAX_BYTES = 10 * 1024 * 1024; // the API's upload limit

const STATUS_LABEL = { ready: 'Ready', pending: 'Processing', failed: 'Failed' };

const ROW_SPRING = { type: 'spring', stiffness: 450, damping: 38 };

// An upload returns at once as "pending"; a worker then reads, splits and
// indexes it. App re-reads the list while anything is pending, so each status
// changes on its own.
function detail(doc) {
  if (doc.status === 'ready') {
    return `${doc.pages} page${doc.pages !== 1 ? 's' : ''}, ${doc.chunk_count} passage${doc.chunk_count !== 1 ? 's' : ''}`;
  }
  if (doc.status === 'failed') return doc.error || 'Processing failed';
  return 'Reading and indexing';
}

const FILTERS = [
  ['all', 'All'],
  ['ready', 'Ready'],
  ['pending', 'Processing'],
  ['failed', 'Failed'],
];

function Library({ documents, onChange, loading, loaded }) {
  const copy = useCopy();
  const pro = useTheme() === 'pro';
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const fileInput = useRef(null);
  const uploadLock = useRef(false);
  const filtered = documents.filter(
    (doc) =>
      doc.name.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || doc.status === filter),
  );

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };

  const handleDrop = (e) => {
    handleDrag(e);
    setDragActive(false);
    if (e.dataTransfer.files?.[0]) upload(e.dataTransfer.files[0]);
  };

  const upload = async (file) => {
    if (uploadLock.current) return;
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setNotice({ type: 'error', text: `“${file.name}” isn’t a PDF. Atlas accepts PDF files only.` });
      return;
    }
    if (file.size > MAX_BYTES) {
      setNotice({ type: 'error', text: `“${file.name}” is over 10 MB. Split it into smaller PDFs.` });
      return;
    }
    uploadLock.current = true;
    setUploading(true);
    setNotice(null);
    const form = new FormData();
    form.append('file', file);
    try {
      const doc = await api('/documents', { method: 'POST', body: form });
      setNotice({
        type: 'ok',
        text:
          doc.status === 'pending'
            ? `Uploaded “${file.name}”. It will be ready to ask about in a moment.`
            : `“${file.name}” is already in your library.`,
      });
      onChange();
    } catch (error) {
      setNotice({ type: 'error', text: error.detail || 'Upload failed. Try again.' });
    } finally {
      uploadLock.current = false;
      setUploading(false);
    }
  };

  const remove = async (doc) => {
    if (!window.confirm(`Delete “${doc.name}” from your library?`)) return;
    setDeletingId(doc.id);
    try {
      await api(`/documents/${doc.id}`, { method: 'DELETE' });
      setNotice({ type: 'ok', text: `Deleted “${doc.name}”.` });
      onChange();
    } catch (error) {
      setNotice({ type: 'error', text: error.detail || `“${doc.name}” couldn’t be deleted. Try again.` });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section className="library">
      <div className="library-heading">
        <h1>{copy.libraryTitle}</h1>
        <p className="lede">{copy.libraryLede}</p>
      </div>
      <Stats documents={documents} loaded={loaded} />

      <div
        className={dragActive ? 'dropzone active' : 'dropzone'}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        onClick={() => !uploading && fileInput.current.click()}
      >
        <div className="upload-icon">
          {uploading ? <Loader size={24} className="spin" /> : <Upload size={24} />}
        </div>
        <div className="dropzone-text">
          <strong>{uploading ? copy.dropBusy : copy.dropTitle}</strong>
          <span>Drop a PDF here or choose a file. Up to 10 MB per document.</span>
        </div>
        <button
          className="btn"
          type="button"
          disabled={uploading}
          onClick={(e) => {
            e.stopPropagation();
            fileInput.current.click();
          }}
        >
          <Upload size={15} />
          Choose PDF
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,application/pdf"
          hidden
          onChange={(e) => {
            if (e.target.files?.[0]) upload(e.target.files[0]);
            e.target.value = '';
          }}
        />
      </div>

      {pro && (
        <aside className="library-guide" aria-labelledby="guide-title">
          <h2 id="guide-title">What happens to a PDF</h2>
          <ol>
            <li>
              <strong>Queued</strong> in your workspace’s own stream, so another tenant’s backlog can’t delay it.
            </li>
            <li>
              <strong>Processed</strong> by a worker: parsed, split into passages and embedded locally.
            </li>
            <li>
              <strong>Ready</strong> once its passages and status commit together, so a crash can’t index it twice.
            </li>
          </ol>
          <p>The same file returns the existing document. New content under the same name replaces it once indexed.</p>
        </aside>
      )}

      {notice && (
        <div className={`notice ${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>
          {notice.type === 'ok' && <Check size={17} />}
          <span>{notice.text}</span>
          <button className="icon-button" onClick={() => setNotice(null)} aria-label="Dismiss notification">
            <X size={16} />
          </button>
        </div>
      )}

      <div className="library-toolbar">
        <h2>Your documents {loaded && <span>{documents.length}</span>}</h2>
        <div className="library-controls">
          <label className="search-field">
            <Search size={15} />
            <input
              aria-label="Search documents"
              placeholder="Find a document…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {pro ? (
            <div className="filter-pills" role="group" aria-label="Filter by status">
              {FILTERS.map(([id, label]) => (
                <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>
                  {filter === id && (
                    <motion.span
                      layoutId="filter-active"
                      className="filter-active"
                      transition={{ type: 'spring', stiffness: 480, damping: 38 }}
                    />
                  )}
                  <span>{label}</span>
                  <small>{id === 'all' ? documents.length : documents.filter((d) => d.status === id).length}</small>
                </button>
              ))}
            </div>
          ) : (
            <select aria-label="Filter by status" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="all">All statuses</option>
              <option value="ready">Ready</option>
              <option value="pending">Processing</option>
              <option value="failed">Failed</option>
            </select>
          )}
        </div>
      </div>
      {loading ? (
        <div className="document-loading" role="status" aria-label="Loading documents">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : !loaded ? (
        <div className="doc-empty panel">
          <CloudOff size={28} strokeWidth={1.3} />
          <h3>Your documents couldn’t be loaded.</h3>
          <p>Atlas isn’t reachable, so nothing can be listed yet. Use Retry at the top of the page.</p>
        </div>
      ) : documents.length === 0 ? (
        <div className="doc-empty panel">
          <BookOpen size={30} strokeWidth={1.3} />
          <h3>{copy.libraryEmpty}</h3>
          <p>Your library is empty. Add a PDF to start asking questions.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="doc-empty panel">
          <Search size={25} />
          <h3>No documents found.</h3>
          <p>Try another name or change the status filter.</p>
          <button
            className="text-button"
            onClick={() => {
              setQuery('');
              setFilter('all');
            }}
          >
            Clear filters
          </button>
        </div>
      ) : (
        <ul className="doc-list">
          <AnimatePresence initial={false} mode="popLayout">
            {filtered.map((doc) => (
              <motion.li
                className="doc"
                data-status={doc.status}
                key={doc.id}
                layout="position"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={ROW_SPRING}
              >
                <div className="file-icon">
                  <FileText size={21} strokeWidth={1.5} />
                  <span>PDF</span>
                </div>
                <div className="doc-main">
                  <p className="doc-name" title={doc.name}>
                    {doc.name}
                  </p>
                  <p className={doc.status === 'failed' ? 'doc-detail failed' : 'doc-detail'}>{detail(doc)}</p>
                </div>
                <AnimatePresence initial={false} mode="wait">
                  <motion.span
                    key={doc.status}
                    className={`status ${doc.status}`}
                    initial={{ opacity: 0, scale: 0.86 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.86 }}
                    transition={{ duration: 0.18 }}
                  >
                    {STATUS_LABEL[doc.status] ?? doc.status}
                  </motion.span>
                </AnimatePresence>
                <button
                  className="delete"
                  onClick={() => remove(doc)}
                  disabled={deletingId === doc.id}
                  aria-label={`Delete ${doc.name}`}
                  title="Delete"
                >
                  {deletingId === doc.id ? <Loader size={16} className="spin" /> : <Trash2 size={16} />}
                </button>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
      <p className="library-footnote">
        Only your workspace can see these documents. Processing updates automatically.
      </p>
    </section>
  );
}

export default Library;
