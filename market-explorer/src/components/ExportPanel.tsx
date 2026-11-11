'use client';

import { useId, useState, type KeyboardEvent } from 'react';
import type { CompanyFilter } from '@/lib/options';
import { curlSnippet, filterJson, sdkSnippet } from '@/lib/snippets';
import { CopyButton, Panel } from './ui';

const TABS = [
  { id: 'json', label: 'Filter JSON', render: filterJson },
  { id: 'sdk', label: 'TypeScript SDK', render: (filter: CompanyFilter) => sdkSnippet(filter) },
  { id: 'curl', label: 'curl (count)', render: curlSnippet },
] as const;

export function ExportPanel({ filter }: { filter: CompanyFilter }) {
  const baseId = useId();
  const [active, setActive] = useState(0);
  const tab = TABS[active] ?? TABS[0];
  const text = tab.render(filter);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const next = (active + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
    setActive(next);
    document.getElementById(`${baseId}-tab-${next}`)?.focus();
  };

  return (
    <Panel
      title="Export"
      description="Take this market to your own code. The count call is free; search costs credits."
      actions={<CopyButton text={text} label={`Copy ${tab.label}`} />}
    >
      <div role="tablist" aria-label="Export format" className="mb-2 flex gap-1 border-b border-line" onKeyDown={onKeyDown}>
        {TABS.map((t, index) => (
          <button
            key={t.id}
            id={`${baseId}-tab-${index}`}
            type="button"
            role="tab"
            aria-selected={index === active}
            aria-controls={`${baseId}-panel`}
            tabIndex={index === active ? 0 : -1}
            onClick={() => setActive(index)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${
              index === active ? 'border-accent font-medium text-ink' : 'border-transparent text-ink-2 hover:text-ink'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <pre
        id={`${baseId}-panel`}
        role="tabpanel"
        aria-labelledby={`${baseId}-tab-${active}`}
        tabIndex={0}
        className="max-h-80 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-xs leading-relaxed"
      >
        {text}
      </pre>
    </Panel>
  );
}
