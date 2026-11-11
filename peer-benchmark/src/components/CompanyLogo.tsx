'use client';

import { useState } from 'react';

/** The logo URL CompanyEnrich returns, or a neutral square when it is missing or fails to load. */
export function CompanyLogo({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span aria-hidden className="size-5 shrink-0 rounded bg-grid" />;
  return (
    // A plain <img>: logos come from many hosts and are tiny, so the Next.js image optimizer adds nothing.
    <img
      src={src}
      alt=""
      width={20}
      height={20}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="size-5 shrink-0 rounded bg-white object-contain"
    />
  );
}
