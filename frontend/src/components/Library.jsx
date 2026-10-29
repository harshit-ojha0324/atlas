import { useRef, useState } from 'react';
import { Upload, Trash2, Loader, FileText, Search, BookOpen, Check, X } from 'lucide-react';
import api from '../services/api';

const MAX_BYTES = 10 * 1024 * 1024; // the API's upload limit

const STATUS_LABEL = { ready: 'Ready', pending: 'Processing', failed: 'Failed' };

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

function Library({ documents, onChange, loading }) {
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
  const ready = documents.filter((doc) => doc.status === 'ready').length;
  const pending = documents.filter((doc) => doc.status === 'pending').length;

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
      <div className="section-topline">
        <p className="eyebrow">
          <span /> THE FOUNDATION OF EVERY ANSWER
        </p>
        <span className="section-index">02 / COLLECT</span>
      </div>
      <div className="library-heading">
        <div>
          <h1>
            Your library.
            <br />
            <em>A world of possibilities.</em>
          </h1>
          <p className="lede">A home for the documents that shape your thinking.</p>
        </div>
        <span className="library-heading-mark">
          <BookOpen size={38} strokeWidth={1} />
        </span>
      </div>
      <div className="library-stats">
        <div>
          <span>DOCUMENTS</span>
          <strong>{loading ? '—' : String(documents.length).padStart(2, '0')}</strong>
        </div>
        <div>
          <span>
            <i className="stat-dot ready" />
            READY TO EXPLORE
          </span>
          <strong>{loading ? '—' : String(ready).padStart(2, '0')}</strong>
        </div>
        <div>
          <span>
            <i className="stat-dot pending" />
            PROCESSING
          </span>
          <strong>{loading ? '—' : String(pending).padStart(2, '0')}</strong>
        </div>
      </div>

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
          <strong>
            {uploading ? 'Making room for new knowledge…' : 'Give your curiosity something to work with.'}
          </strong>
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
        <h2>
          Your documents <span>{documents.length}</span>
        </h2>
        <div className="library-controls">
          <div className="search-field">
            <Search size={15} />
            <input
              aria-label="Search documents"
              placeholder="Find a document…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <select aria-label="Filter by status" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All statuses</option>
            <option value="ready">Ready</option>
            <option value="pending">Processing</option>
            <option value="failed">Failed</option>
          </select>
        </div>
      </div>
      {loading ? (
        <div className="document-loading" role="status" aria-label="Loading documents">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : documents.length === 0 ? (
        <div className="doc-empty">
          <BookOpen size={30} strokeWidth={1.3} />
          <h3>A blank page. Endless potential.</h3>
          <p>Your library is empty. Add a PDF to start asking questions.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="doc-empty">
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
          {filtered.map((doc) => (
            <li className="doc" key={doc.id}>
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
              <span className={`status ${doc.status}`}>{STATUS_LABEL[doc.status] ?? doc.status}</span>
              <button
                className="delete"
                onClick={() => remove(doc)}
                disabled={deletingId === doc.id}
                aria-label={`Delete ${doc.name}`}
                title="Delete"
              >
                {deletingId === doc.id ? <Loader size={16} className="spin" /> : <Trash2 size={16} />}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="library-footnote">
        Only your workspace can see these documents. Processing updates automatically.
      </p>
    </section>
  );
}

export default Library;
