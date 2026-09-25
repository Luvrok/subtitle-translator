export const Icon = ({ children, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">
    {children}
  </svg>
);

export const LogoIcon = ({ size }) => (
  <Icon size={size}>
    <path d="M5 8l6 6" /><path d="M4 14l6-6 2-3" /><path d="M2 5h12" />
    <path d="M7 2h1" /><path d="M22 22l-5-10-5 10" /><path d="M14 18h6" />
  </Icon>
);

export const DownloadIcon = ({ size }) => (
  <Icon size={size}>
    <path d="M21 15v6H3v-6" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
  </Icon>
);

export const UploadIcon = ({ size }) => (
  <Icon size={size}>
    <path d="M21 15v6H3v-6" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
  </Icon>
);

export const CheckIcon = ({ size }) => <Icon size={size}><polyline points="4 12.5 9.5 18 20 6" /></Icon>;
export const CloseIcon = ({ size }) => <Icon size={size}><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></Icon>;
export const StopIcon = ({ size }) => <Icon size={size}><rect x="6" y="6" width="12" height="12" /></Icon>;

export const SunIcon = ({ size }) => (
  <Icon size={size}>
    <rect x="8" y="8" width="8" height="8" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
  </Icon>
);

export const MoonIcon = ({ size }) => <Icon size={size}><path d="M20 14.5A8.5 8.5 0 019.5 4 8.5 8.5 0 1020 14.5z" /></Icon>;

export function StatusIcon({ status }) {
  switch (status) {
    case 'working':
      return <span className="spinner" role="img" aria-label="translating" />;
    case 'queued':
      return <Icon><rect x="3" y="3" width="18" height="18" /><polyline points="12 7 12 12 15 14" /></Icon>;
    case 'done':
      return <Icon><rect x="3" y="3" width="18" height="18" /><polyline points="7.5 12.5 10.5 15.5 16.5 9" /></Icon>;
    case 'error':
    case 'invalid':
      return <Icon><rect x="3" y="3" width="18" height="18" /><line x1="12" y1="7.5" x2="12" y2="13" /><line x1="12" y1="16.5" x2="12" y2="16.5" /></Icon>;
    case 'stopped':
      return <Icon><rect x="3" y="3" width="18" height="18" /><line x1="8" y1="12" x2="16" y2="12" /></Icon>;
    default:
      return <Icon><rect x="3" y="3" width="18" height="18" /></Icon>;
  }
}
