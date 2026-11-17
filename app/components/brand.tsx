export function BrandMark() {
  return (
    <svg className="brand-mark" width="32" height="24" viewBox="0 0 48 36" fill="none" aria-hidden="true" focusable="false">
      <path d="M0 21V6a6 6 0 0 1 12 0v15Z" fill="#F24E1E" />
      <path d="M0 21h12a3 3 0 0 0 6 0h6v12A15 15 0 0 1 0 21Z" fill="#A259FF" />
      <path d="M18 21v-6a6 6 0 0 1 12 0v6Z" fill="#FF7262" />
      <path d="M24 21h6a3 3 0 0 0 6 0h12a15 15 0 0 1-24 12Z" fill="#0ACF83" />
      <path d="M36 21V6a6 6 0 0 1 12 0v15Z" fill="#1ABCFE" />
    </svg>
  );
}

export function Brand() {
  return (
    <span className="brand">
      <BrandMark />
      <span>Workspace</span>
    </span>
  );
}
