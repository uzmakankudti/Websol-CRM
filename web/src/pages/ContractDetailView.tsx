/**
 * Contract detail view (shared by the Customers and Contracts screens).
 *
 * Shows a single contract's terms, the printers it covers, and attached
 * signed documents, plus every lifecycle action gated by permission and
 * the contract's status:
 *
 *   - Edit / Delete          DRAFT only (BR-010: no delete after activation)
 *   - Attach document        any non-terminated contract
 *   - Activate               DRAFT → ACTIVE, requires a document (BR-007)
 *   - Terminate              ACTIVE/EXPIRED → TERMINATED, reason required
 *
 * The backend re-enforces all of these rules; the UI mirrors them so the
 * user gets immediate, specific feedback.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/context';
import { PERM, type Contract, type ContractDetail, type SlaTier } from '../types';
import {
  SLA_TIERS,
  contractStatusBadge,
  fmtDate,
  fmtDateTime,
  fmtMoney,
  fmtRate,
  slaBadge,
} from './contract-format';

// ---------------------------------------------------------------------------
// ContractDetailView
// ---------------------------------------------------------------------------

type Modal =
  | { kind: 'edit' }
  | { kind: 'activate' }
  | { kind: 'terminate' }
  | { kind: 'upload' }
  | { kind: 'delete' }
  | null;

export default function ContractDetailView({
  contractId,
  onBack,
  onDeleted,
}: {
  contractId: number;
  onBack: () => void;
  onDeleted?: () => void;
}) {
  const { can } = useAuth();
  const [detail, setDetail] = useState<ContractDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState<Modal>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const data = await api.get<ContractDetail>(`/contracts/${contractId}`);
      setDetail(data);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to load contract');
    } finally {
      setLoading(false);
    }
  }, [contractId]);

  useEffect(() => {
    void load();
  }, [load]);

  function afterChange(message?: string) {
    setModal(null);
    if (message) setNotice(message);
    void load();
  }

  async function downloadDoc(docId: number, fileName: string) {
    try {
      const data = await api.get<{
        document: { content: string; mimeType: string; fileName: string };
      }>(`/contracts/${contractId}/documents/${docId}`);
      const { content, mimeType } = data.document;
      const byteChars = atob(content);
      const bytes = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
      const blob = new Blob([bytes], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to download document');
    }
  }

  if (loading) return <p className="muted">Loading…</p>;
  if (err && !detail) return <div className="alert alert-error">{err}</div>;
  if (!detail) return null;

  const { contract, printers, documents } = detail;
  const isDraft = contract.status === 'DRAFT';
  const hasDocument = documents.length > 0;

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button className="btn btn-secondary btn-sm" onClick={onBack}>
            ← Back
          </button>
          <h2 style={{ margin: 0 }}>{contract.contractNo}</h2>
          <span className={contractStatusBadge(contract.status)}>{contract.status}</span>
          <span className={slaBadge(contract.slaTier)}>{contract.slaTier}</span>
        </div>
        <div className="row-actions">
          {can(PERM.contractsUpdate) && isDraft && (
            <button className="btn btn-secondary" onClick={() => setModal({ kind: 'edit' })}>
              Edit
            </button>
          )}
          {can(PERM.contractsUpdate) && contract.status !== 'TERMINATED' && (
            <button className="btn btn-secondary" onClick={() => setModal({ kind: 'upload' })}>
              Attach document
            </button>
          )}
          {can(PERM.contractsActivate) && isDraft && (
            <button
              className={`btn ${hasDocument ? '' : 'btn-secondary'}`}
              title={hasDocument ? 'Activate contract' : 'Requires a signed document (BR-007)'}
              onClick={() => setModal({ kind: 'activate' })}
            >
              Activate
            </button>
          )}
          {can(PERM.contractsTerminate) &&
            (contract.status === 'ACTIVE' || contract.status === 'EXPIRED') && (
              <button className="btn btn-danger" onClick={() => setModal({ kind: 'terminate' })}>
                Terminate
              </button>
            )}
          {can(PERM.contractsUpdate) && isDraft && (
            <button className="btn btn-danger" onClick={() => setModal({ kind: 'delete' })}>
              Delete
            </button>
          )}
        </div>
      </div>

      {notice && <div className="alert alert-success">{notice}</div>}
      {err && <div className="alert alert-error">{err}</div>}

      {contract.status === 'ACTIVE' && contract.expiringSoon && (
        <div className="alert alert-info">
          This contract expires in {contract.daysUntilExpiry} day
          {contract.daysUntilExpiry === 1 ? '' : 's'} (on {fmtDate(contract.endDate)}).
        </div>
      )}
      {contract.status === 'EXPIRED' && (
        <div className="alert alert-info">
          This contract expired on {fmtDate(contract.endDate)}. Terminate it to close it out.
        </div>
      )}
      {contract.status === 'TERMINATED' && (
        <div className="alert alert-error">
          Terminated on {fmtDateTime(contract.terminatedAt)} by{' '}
          {contract.terminatedBy?.fullName ?? '—'}
          {contract.terminationReason ? ` — "${contract.terminationReason}"` : ''}
        </div>
      )}
      {isDraft && !hasDocument && (
        <div className="alert alert-info">
          BR-007: attach a signed contract document before this contract can be activated.
        </div>
      )}

      <div className="detail-grid">
        {/* Terms */}
        <section className="detail-card">
          <h3>Terms</h3>
          <dl className="detail-list">
            <dt>Customer</dt>
            <dd>{contract.customerName}</dd>
            <dt>Start date</dt>
            <dd>{fmtDate(contract.startDate)}</dd>
            <dt>End date</dt>
            <dd>{fmtDate(contract.endDate)}</dd>
            <dt>SLA tier</dt>
            <dd>
              <span className={slaBadge(contract.slaTier)}>{contract.slaTier}</span>
            </dd>
            <dt>Monthly lease fee</dt>
            <dd>{fmtMoney(contract.monthlyLeaseFee)}</dd>
            <dt>Per-click B/W</dt>
            <dd>{fmtRate(contract.perClickBw)}</dd>
            <dt>Per-click colour</dt>
            <dd>{fmtRate(contract.perClickColour)}</dd>
            {contract.notes && (
              <>
                <dt>Notes</dt>
                <dd>{contract.notes}</dd>
              </>
            )}
            <dt>Created by</dt>
            <dd>{contract.createdBy.fullName ?? '—'}</dd>
            {contract.activatedAt && (
              <>
                <dt>Activated</dt>
                <dd>
                  {fmtDateTime(contract.activatedAt)} by {contract.activatedBy?.fullName ?? '—'}
                </dd>
              </>
            )}
          </dl>
        </section>

        {/* Printers */}
        <section className="detail-card">
          <h3>Printers covered</h3>
          {printers.length === 0 ? (
            <p className="muted">No printers on this contract.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Serial</th>
                  <th>Qty</th>
                </tr>
              </thead>
              <tbody>
                {printers.map((p) => (
                  <tr key={p.id}>
                    <td>{p.printerModel}</td>
                    <td className="muted">{p.serialNo ?? '—'}</td>
                    <td>{p.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* Documents */}
        <section className="detail-card">
          <h3>Signed documents</h3>
          {documents.length === 0 ? (
            <p className="muted">No documents attached yet.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Uploaded</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {documents.map((d) => (
                  <tr key={d.id}>
                    <td>{d.fileName}</td>
                    <td className="muted">
                      {fmtDateTime(d.uploadedAt)}
                      {d.uploadedBy?.fullName ? ` · ${d.uploadedBy.fullName}` : ''}
                    </td>
                    <td>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => void downloadDoc(d.id, d.fileName)}
                      >
                        Download
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {modal?.kind === 'edit' && (
        <ContractFormModal
          customerId={contract.customerId}
          existing={contract}
          onClose={() => setModal(null)}
          onSaved={() => afterChange('Contract updated.')}
        />
      )}
      {modal?.kind === 'upload' && (
        <UploadDocumentModal
          contractId={contract.id}
          onClose={() => setModal(null)}
          onSaved={() => afterChange('Document attached.')}
        />
      )}
      {modal?.kind === 'activate' && (
        <ActivateModal
          contract={contract}
          hasDocument={hasDocument}
          onClose={() => setModal(null)}
          onSaved={() => afterChange('Contract activated.')}
        />
      )}
      {modal?.kind === 'terminate' && (
        <TerminateModal
          contract={contract}
          onClose={() => setModal(null)}
          onSaved={() => afterChange('Contract terminated.')}
        />
      )}
      {modal?.kind === 'delete' && (
        <DeleteContractModal
          contract={contract}
          onClose={() => setModal(null)}
          onDeleted={() => {
            setModal(null);
            if (onDeleted) onDeleted();
            else onBack();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contract create / edit form
// ---------------------------------------------------------------------------

interface PrinterLine {
  printerModel: string;
  serialNo: string;
  quantity: string;
}

export function ContractFormModal({
  customerId,
  existing,
  onClose,
  onSaved,
}: {
  customerId: number;
  existing?: Contract;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [startDate, setStartDate] = useState(existing?.startDate ?? '');
  const [endDate, setEndDate] = useState(existing?.endDate ?? '');
  const [monthlyLeaseFee, setMonthlyLeaseFee] = useState(
    existing ? String(existing.monthlyLeaseFee) : '',
  );
  const [perClickBw, setPerClickBw] = useState(existing ? String(existing.perClickBw) : '');
  const [perClickColour, setPerClickColour] = useState(
    existing ? String(existing.perClickColour) : '',
  );
  const [slaTier, setSlaTier] = useState<SlaTier>(existing?.slaTier ?? 'BRONZE');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [printers, setPrinters] = useState<PrinterLine[]>([
    { printerModel: '', serialNo: '', quantity: '1' },
  ]);
  const [includePrinters, setIncludePrinters] = useState(!existing);
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);

  function addPrinter() {
    setPrinters((prev) => [...prev, { printerModel: '', serialNo: '', quantity: '1' }]);
  }
  function updatePrinter(idx: number, field: keyof PrinterLine, value: string) {
    setPrinters((prev) => prev.map((p, i) => (i === idx ? { ...p, [field]: value } : p)));
  }
  function removePrinter(idx: number) {
    setPrinters((prev) => prev.filter((_, i) => i !== idx));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormErr('');

    const fee = parseFloat(monthlyLeaseFee);
    const bw = parseFloat(perClickBw);
    const colour = parseFloat(perClickColour);

    // BR-009 — pricing guards mirrored from the backend.
    if (isNaN(fee) || fee <= 0) {
      setFormErr('Monthly lease fee must be greater than 0 (BR-009)');
      return;
    }
    if (isNaN(bw) || bw < 0) {
      setFormErr('Per-click B/W rate must be 0 or more (BR-009)');
      return;
    }
    if (isNaN(colour) || colour < 0) {
      setFormErr('Per-click colour rate must be 0 or more (BR-009)');
      return;
    }
    if (!startDate || !endDate) {
      setFormErr('Start and end dates are required');
      return;
    }
    // BR-008 — end date at least one month after start.
    const start = new Date(`${startDate}T00:00:00`);
    const minEnd = new Date(start);
    minEnd.setMonth(minEnd.getMonth() + 1);
    if (new Date(`${endDate}T00:00:00`) < minEnd) {
      setFormErr('End date must be at least one month after the start date (BR-008)');
      return;
    }

    const printerPayload =
      includePrinters || !existing
        ? printers.map((p) => ({
            printerModel: p.printerModel.trim(),
            serialNo: p.serialNo.trim() || null,
            quantity: parseInt(p.quantity, 10) || 1,
          }))
        : undefined;

    if (printerPayload) {
      for (const p of printerPayload) {
        if (!p.printerModel) {
          setFormErr('Every printer line needs a model name');
          return;
        }
      }
      if (!printerPayload.length) {
        setFormErr('A contract must cover at least one printer');
        return;
      }
    }

    setBusy(true);
    try {
      const payload = {
        startDate,
        endDate,
        monthlyLeaseFee: fee,
        perClickBw: bw,
        perClickColour: colour,
        slaTier,
        notes: notes.trim() || null,
        ...(printerPayload ? { printers: printerPayload } : {}),
      };
      if (existing) {
        await api.patch(`/contracts/${existing.id}`, payload);
      } else {
        await api.post(`/customers/${customerId}/contracts`, payload);
      }
      onSaved();
    } catch (e) {
      setFormErr(e instanceof ApiError ? e.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <h3>{existing ? `Edit contract ${existing.contractNo}` : 'New contract'}</h3>
      {formErr && <div className="alert alert-error">{formErr}</div>}
      <form onSubmit={onSubmit}>
        <div className="form-row">
          <div>
            <label htmlFor="sd">Start date</label>
            <input
              id="sd"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              required
            />
          </div>
          <div>
            <label htmlFor="ed">End date</label>
            <input
              id="ed"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              required
            />
          </div>
        </div>
        <p className="muted" style={{ fontSize: '0.8rem', marginTop: 0 }}>
          Typical lease duration is 2–5 years; the minimum is one month (BR-008).
        </p>

        <label htmlFor="sla">SLA tier</label>
        <select id="sla" value={slaTier} onChange={(e) => setSlaTier(e.target.value as SlaTier)}>
          {SLA_TIERS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        <label htmlFor="mlf">Monthly lease fee (ZAR)</label>
        <input
          id="mlf"
          type="number"
          step="0.01"
          min="0.01"
          value={monthlyLeaseFee}
          onChange={(e) => setMonthlyLeaseFee(e.target.value)}
          required
          placeholder="e.g. 2500.00"
        />
        <div className="form-row">
          <div>
            <label htmlFor="pcbw">Per-click B/W (ZAR)</label>
            <input
              id="pcbw"
              type="number"
              step="0.00001"
              min="0"
              value={perClickBw}
              onChange={(e) => setPerClickBw(e.target.value)}
              required
              placeholder="e.g. 0.00800"
            />
          </div>
          <div>
            <label htmlFor="pccol">Per-click colour (ZAR)</label>
            <input
              id="pccol"
              type="number"
              step="0.00001"
              min="0"
              value={perClickColour}
              onChange={(e) => setPerClickColour(e.target.value)}
              required
              placeholder="e.g. 0.05000"
            />
          </div>
        </div>

        {existing && (
          <label
            style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.75rem' }}
          >
            <input
              type="checkbox"
              checked={includePrinters}
              onChange={(e) => setIncludePrinters(e.target.checked)}
              style={{ width: 'auto' }}
            />
            Replace printer list
          </label>
        )}

        {(includePrinters || !existing) && (
          <div style={{ marginTop: '0.75rem' }}>
            <label>Printers</label>
            {printers.map((p, idx) => (
              <div key={idx} className="printer-row">
                <input
                  placeholder="Model"
                  value={p.printerModel}
                  onChange={(e) => updatePrinter(idx, 'printerModel', e.target.value)}
                  style={{ flex: 2 }}
                />
                <input
                  placeholder="Serial (optional)"
                  value={p.serialNo}
                  onChange={(e) => updatePrinter(idx, 'serialNo', e.target.value)}
                  style={{ flex: 1 }}
                />
                <input
                  type="number"
                  min={1}
                  placeholder="Qty"
                  value={p.quantity}
                  onChange={(e) => updatePrinter(idx, 'quantity', e.target.value)}
                  style={{ flex: '0 0 70px' }}
                />
                {printers.length > 1 && (
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => removePrinter(idx)}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            <button type="button" className="btn btn-secondary btn-sm" onClick={addPrinter}>
              + Add printer
            </button>
          </div>
        )}

        <label htmlFor="cnotes" style={{ marginTop: '1rem', display: 'block' }}>
          Notes (optional)
        </label>
        <textarea
          id="cnotes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          style={{ width: '100%', resize: 'vertical' }}
        />

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Saving…' : existing ? 'Save changes' : 'Create draft contract'}
          </button>
        </div>
      </form>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Upload document modal
// ---------------------------------------------------------------------------

function UploadDocumentModal({
  contractId,
  onClose,
  onSaved,
}: {
  contractId: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);

  function readAsBase64(f: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result);
        // Strip the "data:<mime>;base64," prefix.
        resolve(result.slice(result.indexOf(',') + 1));
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(f);
    });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormErr('');
    if (!file) {
      setFormErr('Choose a file to attach');
      return;
    }
    setBusy(true);
    try {
      const content = await readAsBase64(file);
      await api.post(`/contracts/${contractId}/documents`, {
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        content,
      });
      onSaved();
    } catch (e) {
      setFormErr(e instanceof ApiError ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <h3>Attach signed document</h3>
      <p className="muted">
        Upload the signed contract (PDF, image or document). A signed document is required before
        activation (BR-007).
      </p>
      {formErr && <div className="alert alert-error">{formErr}</div>}
      <form onSubmit={onSubmit}>
        <input
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.doc,.docx"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </form>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Activate modal
// ---------------------------------------------------------------------------

function ActivateModal({
  contract,
  hasDocument,
  onClose,
  onSaved,
}: {
  contract: Contract;
  hasDocument: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function run() {
    setFormErr('');
    setBusy(true);
    try {
      await api.post(`/contracts/${contract.id}/activate`);
      onSaved();
    } catch (e) {
      setFormErr(e instanceof ApiError ? e.message : 'Activation failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <h3>Activate {contract.contractNo}</h3>
      {!hasDocument ? (
        <div className="alert alert-error">
          BR-007: a signed contract document must be attached before this contract can be activated.
        </div>
      ) : (
        <p className="muted">
          Activating starts the lease. Once active, the contract can no longer be deleted — it must
          be terminated instead (BR-010).
        </p>
      )}
      {formErr && <div className="alert alert-error">{formErr}</div>}
      <div className="modal-actions">
        <button className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        {hasDocument && (
          <button className="btn" onClick={run} disabled={busy}>
            {busy ? 'Activating…' : 'Activate contract'}
          </button>
        )}
      </div>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Terminate modal
// ---------------------------------------------------------------------------

function TerminateModal({
  contract,
  onClose,
  onSaved,
}: {
  contract: Contract;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState('');
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormErr('');
    if (!reason.trim()) {
      setFormErr('A termination reason is required');
      return;
    }
    setBusy(true);
    try {
      await api.post(`/contracts/${contract.id}/terminate`, { reason: reason.trim() });
      onSaved();
    } catch (e) {
      setFormErr(e instanceof ApiError ? e.message : 'Termination failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <h3>Terminate {contract.contractNo}</h3>
      <p className="muted">
        Termination is permanent and preserves the contract for the record (BR-010).
      </p>
      {formErr && <div className="alert alert-error">{formErr}</div>}
      <form onSubmit={onSubmit}>
        <label htmlFor="tr">Reason</label>
        <input
          id="tr"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          placeholder="Why is this contract being terminated?"
        />
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-danger" disabled={busy}>
            {busy ? 'Terminating…' : 'Terminate contract'}
          </button>
        </div>
      </form>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Delete (DRAFT only) modal
// ---------------------------------------------------------------------------

function DeleteContractModal({
  contract,
  onClose,
  onDeleted,
}: {
  contract: Contract;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function run() {
    setFormErr('');
    setBusy(true);
    try {
      await api.delete(`/contracts/${contract.id}`);
      onDeleted();
    } catch (e) {
      setFormErr(e instanceof ApiError ? e.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Backdrop onClose={onClose}>
      <h3>Delete {contract.contractNo}?</h3>
      <p className="muted">
        This draft contract will be permanently removed. Only draft contracts can be deleted;
        activated contracts must be terminated (BR-010).
      </p>
      {formErr && <div className="alert alert-error">{formErr}</div>}
      <div className="modal-actions">
        <button className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-danger" onClick={run} disabled={busy}>
          {busy ? 'Deleting…' : 'Delete draft'}
        </button>
      </div>
    </Backdrop>
  );
}

// ---------------------------------------------------------------------------
// Shared backdrop
// ---------------------------------------------------------------------------

export function Backdrop({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
