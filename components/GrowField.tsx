'use client';

import { useLayoutEffect, useRef, useState } from 'react';

import { cx } from '@/lib/client';

import styles from './GrowField.module.css';
import ui from './ui.module.css';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Lines shown while the field is not being edited. */
  rows?: number;
  'aria-label'?: string;
}

/**
 * A text box that shows a line or two at rest and grows to fit everything while it has focus
 * (CSS does the growing). Text that doesn't fit at rest fades out at the bottom.
 */
export function GrowField({ value, onChange, placeholder, rows = 2, ...rest }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [more, setMore] = useState(false);

  // Measured at rest only: while focused the field is as tall as its text.
  const measure = () => {
    const el = ref.current;
    if (el && document.activeElement !== el) setMore(el.value.length > 0 && el.scrollHeight > el.clientHeight + 1);
  };
  useLayoutEffect(measure, [value]);

  return (
    <textarea
      ref={ref}
      className={cx(ui.textarea, styles.field, more && styles.more)}
      style={{ ['--rows' as string]: rows }}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => requestAnimationFrame(measure)}
      {...rest}
    />
  );
}
