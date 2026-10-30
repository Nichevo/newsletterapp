import type { SVGProps } from 'react';

type Props = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 22, ...rest }: Props) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...rest,
  };
}

export const IconInbox = (p: Props) => (
  <svg {...base(p)}>
    <path d="M3 13l3-8h12l3 8v6H3z" />
    <path d="M3 13h5l1 2h6l1-2h5" />
  </svg>
);
export const IconBookmark = (p: Props) => (
  <svg {...base(p)}>
    <path d="M6 3h12v18l-6-4-6 4z" />
  </svg>
);
export const IconShield = (p: Props) => (
  <svg {...base(p)}>
    <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
);
export const IconSettings = (p: Props) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
  </svg>
);
export const IconPlus = (p: Props) => (
  <svg {...base({ strokeWidth: 2, ...p })}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const IconBack = (p: Props) => (
  <svg {...base(p)}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
);
export const IconFilter = (p: Props) => (
  <svg {...base(p)}>
    <path d="M4 6h16M7 12h10M10 18h4" />
  </svg>
);
export const IconChevron = (p: Props) => (
  <svg {...base(p)}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);
export const IconCheck = (p: Props) => (
  <svg {...base(p)}>
    <path d="M5 12l5 5 9-10" />
  </svg>
);
export const IconArchive = (p: Props) => (
  <svg {...base(p)}>
    <rect x="3" y="4" width="18" height="5" rx="1" />
    <path d="M5 9v10h14V9M10 13h4" />
  </svg>
);
export const IconExternal = (p: Props) => (
  <svg {...base(p)}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" />
  </svg>
);
export const IconImage = (p: Props) => (
  <svg {...base(p)}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 16l5-5 4 4 3-3 6 6" />
    <circle cx="16" cy="9" r="1.5" />
  </svg>
);
export const IconRefresh = (p: Props) => (
  <svg {...base(p)}>
    <path d="M20 12a8 8 0 1 1-2.3-5.7" />
    <path d="M20 4v5h-5" />
  </svg>
);
export const IconCopy = (p: Props) => (
  <svg {...base(p)}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a1 1 0 0 1 1-1h10" />
  </svg>
);
