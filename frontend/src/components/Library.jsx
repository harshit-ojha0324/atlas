import { useRef, useState } from 'react';
import { Upload, Trash2, Loader } from 'lucide-react';
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

function Library({ documents, onChange }) {
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const fileInput = useRef(null);

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
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setNotice({ type: 'error', text: `“${file.name}” isn’t a PDF. Atlas accepts PDF files only.` });
      return;
    }
    if (file.size > MAX_BYTES) {
      setNotice({ type: 'error', text: `“${file.name}” is over 10 MB. Split it into smaller PDFs.` });
      return;
    }
    setUploading(true);
    setNotice(null);
    const form = new FormData();
    form.append('file', file);
    try {
      const doc = await api('/documents', { method: 'POST', body: form });
      setNotice({
        type: 'ok',
        text: doc.status === 'pending'
          ? `Uploaded “${file.name}”. It will be ready to ask about in a moment.`
          : `“${file.name}” is already in your library.`,
      });
      onChange();
    } catch (error) {
      setNotice({ type: 'error', text: error.detail || 'Upload failed. Try again.' });
    } finally {
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
      <h2>Library</h2>
      <p className="lede">The PDFs Atlas answers from. Only your workspace can see them.</p>

      <div
        className={dragActive ? 'dropzone active' : 'dropzone'}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        onClick={() => !uploading && fileInput.current.click()}
      >
        {uploading ? <Loader size={26} className="spin" /> : <Upload size={26} />}
        <div className="dropzone-text">
          <strong>{uploading ? 'Uploading…' : 'Drop a PDF here'}</strong>
          <span>Up to 10 MB. It’s searchable once it’s marked ready.</span>
        </div>
        <button
          className="btn"
          type="button"
          disabled={uploading}
          onClick={(e) => { e.stopPropagation(); fileInput.current.click(); }}
        >
          Choose PDF
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,application/pdf"
          hidden
          onChange={(e) => { if (e.target.files?.[0]) upload(e.target.files[0]); e.target.value = ''; }}
        />
      </div>

      {notice && <p className={`notice ${notice.type}`} role="status">{notice.text}</p>}

      {documents.length === 0 ? (
        <p className="doc-empty">Your library is empty. Add a PDF to start asking questions.</p>
      ) : (
        <ul className="doc-list">
          {documents.map((doc) => (
            <li className="doc" key={doc.id}>
              <div className="doc-main">
                <p className="doc-name">{doc.name}</p>
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
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default Library;
