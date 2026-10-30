import type { Address, Me } from '@newsletterapp/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { IconBack, IconCopy } from '../icons';

export function AddPage({ me }: { me: Me }) {
  const navigate = useNavigate();
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<Address | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    api.addresses().then(setAddresses).catch(() => undefined);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!label.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const a = await api.createAddress(label.trim());
      setCreated(a);
      setAddresses((prev) => [a, ...prev]);
      setLabel('');
      await copy(a.email);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the address');
    } finally {
      setBusy(false);
    }
  }

  async function copy(email: string) {
    try {
      await navigator.clipboard.writeText(email);
      setCopied(email);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard can be unavailable (http, older browsers); the address is still shown.
    }
  }

  async function toggleBlock(a: Address) {
    try {
      const updated = await api.addressAction(a.id, a.status === 'blocked' ? 'unblock' : 'block');
      setAddresses((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar__titles" style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <button className="iconbtn" aria-label="Back" onClick={() => navigate(-1)}>
            <IconBack />
          </button>
          <h1>Add a newsletter</h1>
        </div>
      </header>

      <div className="section">
        <form className="card" onSubmit={submit}>
          <p className="hint" style={{ margin: 0 }}>
            Use a new address for each newsletter, so you always know who sent what, and who shared your address.
          </p>
          <div className="field">
            <label htmlFor="nl-name">Newsletter name</label>
            <input
              id="nl-name"
              className="input"
              placeholder="e.g. Money Matters"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              autoComplete="off"
            />
          </div>
          {me.domain ? null : (
            <p className="hint" style={{ margin: 0, color: 'var(--amber-ink)' }}>
              MAIL_DOMAIN isn't set yet, so only the first half of the address is shown. Add it as a deploy variable (see README).
            </p>
          )}
          <button className="btn btn--primary" disabled={busy || !label.trim()} type="submit">
            Create address
          </button>
          {error && <div className="error" style={{ margin: 0 }}>{error}</div>}
          {created && (
            <>
              <div className="addressbox">
                <strong>{created.email}</strong>
                <button type="button" className="btn btn--primary btn--small" onClick={() => void copy(created.email)}>
                  <IconCopy size={16} /> {copied === created.email ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p className="hint" style={{ margin: 0 }}>
                Paste it into the newsletter's sign-up form. The confirmation email will appear in your inbox here, and the first
                sender to this address is allowed automatically.
              </p>
            </>
          )}
        </form>
      </div>

      {addresses.length > 0 && (
        <div className="section">
          <span className="label">Your addresses</span>
          <div className="card card--list">
            {addresses.map((a) => (
              <div key={a.id} className="cardrow">
                <div className="cardrow__main">
                  <span className="cardrow__title">{a.label ?? a.localPart}</span>
                  <span className="cardrow__sub">
                    {a.email}
                    {a.status === 'blocked'
                      ? ` · blocked · ${a.blockedCount} email${a.blockedCount === 1 ? '' : 's'} stopped`
                      : a.approvedSenderCount > 0
                        ? ` · ${a.approvedSenderCount} allowed sender${a.approvedSenderCount === 1 ? '' : 's'}`
                        : ' · waiting for its first email'}
                  </span>
                </div>
                <button className="iconbtn" aria-label={`Copy ${a.email}`} onClick={() => void copy(a.email)}>
                  <IconCopy size={18} />
                </button>
                <button className="btn btn--small" onClick={() => void toggleBlock(a)}>
                  {a.status === 'blocked' ? 'Unblock' : 'Block'}
                </button>
              </div>
            ))}
          </div>
          <p className="hint">Block an address if it starts getting spam or was passed on. Everything sent to it is then dropped.</p>
        </div>
      )}
    </div>
  );
}
