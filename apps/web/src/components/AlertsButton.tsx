import type { ProblemsSummary, SecuritySummary, StatusSummary } from '@newsletterapp/shared';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { IconBell, IconPulse, IconShieldAlert } from '../icons';
import { StatusDot, statusButtonLabel, statusButtonLevel } from '../pages/Status';
import { SecurityDot, securityButtonLabel } from '../pages/Security';

// One top-bar button for System status (services + the app's own problems) and
// Security alerts, so the inbox bar fits a narrow phone. Its dot is the worse of
// the two. With only one of them switched on it opens that page straight away;
// with both it opens a small menu with a row (dot and words) for each.

const RANK: Record<string, number> = { major: 3, minor: 2, ok: 1 };
const SEC_DOT: Record<SecuritySummary['level'], string> = { high: 'major', medium: 'minor', watch: 'minor', low: 'minor', ok: 'ok', off: 'off' };

export function alertsLevel(status: StatusSummary, problems: ProblemsSummary, security: SecuritySummary): string {
  const a = statusOn(status, problems) ? statusButtonLevel(status, problems) : 'off';
  const b = SEC_DOT[security.level];
  return (RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a;
}

const statusOn = (s: StatusSummary, p: ProblemsSummary) => s.level !== 'off' || p.open > 0;

export function AlertsButton({ status, problems, security }: { status: StatusSummary; problems: ProblemsSummary; security: SecuritySummary }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const showStatus = statusOn(status, problems);
  const showSecurity = security.level !== 'off';

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  if (!showStatus && !showSecurity) return null;
  const statusLabel = statusButtonLabel(status, problems);
  const securityLabel = securityButtonLabel(security);
  const dot = <span className={`sdot sdot--${alertsLevel(status, problems, security)}`} aria-hidden="true" />;

  if (!showSecurity)
    return (
      <Link to="/status" className="iconbtn statusbtn" aria-label={statusLabel} title={statusLabel}>
        <IconPulse />
        {dot}
      </Link>
    );
  if (!showStatus)
    return (
      <Link to="/security" className="iconbtn statusbtn" aria-label={securityLabel} title={securityLabel}>
        <IconShieldAlert />
        {dot}
      </Link>
    );

  const label = `Alerts: ${statusLabel}; ${securityLabel}`;
  return (
    <div className="alertsmenu" ref={wrap}>
      <button
        type="button"
        className="iconbtn statusbtn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <IconBell />
        {dot}
      </button>
      {open && (
        <div className="alertsmenu__list" role="menu">
          <Link to="/status" role="menuitem" className="alertsmenu__row" onClick={() => setOpen(false)}>
            <IconPulse size={20} />
            <span className="alertsmenu__text">
              <strong>System status</strong>
              <span>{statusLabel.replace(/^System status:?\s*(·\s*)?/, '') || 'Services you follow'}</span>
            </span>
            <StatusDot level={statusButtonLevel(status, problems)} />
          </Link>
          <Link to="/security" role="menuitem" className="alertsmenu__row" onClick={() => setOpen(false)}>
            <IconShieldAlert size={20} />
            <span className="alertsmenu__text">
              <strong>Security alerts</strong>
              <span>{securityLabel.replace(/^Security alerts:?\s*/, '') || 'Breach alerts'}</span>
            </span>
            <SecurityDot level={security.level} />
          </Link>
        </div>
      )}
    </div>
  );
}
