/** Inline 16px line icons; they take the text colour. */

const base = { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export const PlusIcon = () => (
  <svg {...base}>
    <path d="M8 3v10M3 8h10" />
  </svg>
);

export const CheckIcon = () => (
  <svg {...base} strokeWidth={1.8}>
    <path d="M3.5 8.5l3 3 6-7" />
  </svg>
);

export const BackIcon = () => (
  <svg {...base}>
    <path d="M10 3.5L5.5 8l4.5 4.5" />
  </svg>
);

export const NextIcon = () => (
  <svg {...base}>
    <path d="M6 3.5L10.5 8 6 12.5" />
  </svg>
);

export const SparkIcon = () => (
  <svg {...base}>
    <path d="M8 2.5l1.3 3.2 3.2 1.3-3.2 1.3L8 11.5 6.7 8.3 3.5 7l3.2-1.3z" />
    <path d="M12.5 11.5l.5 1.2 1.2.5-1.2.5-.5 1.2-.5-1.2-1.2-.5 1.2-.5z" />
  </svg>
);

export const RedoIcon = () => (
  <svg {...base}>
    <path d="M12.5 5.5A5 5 0 1 0 13 9" />
    <path d="M12.8 2.5v3h-3" />
  </svg>
);

export const BookIcon = () => (
  <svg {...base}>
    <path d="M8 4.5c-1.5-1-3.5-1.3-5.5-1v9c2-.3 4 0 5.5 1 1.5-1 3.5-1.3 5.5-1v-9c-2-.3-4 0-5.5 1zM8 4.5v9" />
  </svg>
);

export const TrashIcon = () => (
  <svg {...base}>
    <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
  </svg>
);
