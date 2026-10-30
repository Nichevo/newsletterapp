import { NavLink } from 'react-router-dom';
import { IconBookmark, IconDigest, IconInbox, IconSettings, IconShield } from '../icons';

export function TabBar({ pendingSenders }: { pendingSenders: number }) {
  return (
    <nav className="tabbar" aria-label="Main">
      <NavLink to="/" end>
        <IconInbox />
        Inbox
      </NavLink>
      <NavLink to="/digest">
        <IconDigest />
        Digest
      </NavLink>
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
