import { NavLink } from 'react-router-dom';
import { IconBookmark, IconDigest, IconInbox, IconSettings, IconShield } from '../icons';

export function TabBar({ pendingSenders, showReview }: { pendingSenders: number; showReview: boolean }) {
  return (
    <nav className="tabbar" aria-label="Main">
      <NavLink to="/" end>
        <IconInbox />
        Inbox
      </NavLink>
      {showReview && (
        <NavLink to="/review">
          <IconDigest />
          Review
        </NavLink>
      )}
      <NavLink to="/saved">
        <IconBookmark />
        Saved
      </NavLink>
      <NavLink to="/senders">
        <IconShield />
        Senders
        {pendingSenders > 0 && <span className="tabbar__badge">{pendingSenders}</span>}
      </NavLink>
      <NavLink to="/settings">
        <IconSettings />
        Settings
      </NavLink>
    </nav>
  );
}
