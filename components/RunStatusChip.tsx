import { cx } from '@/lib/client';
import type { RunStatus } from '@/lib/types';

import ui from './ui.module.css';

/** A run's state in one chip, on the library list and the run page alike. */
export function RunStatusChip({ status, done, total }: { status: RunStatus; done: number; total: number }) {
  if (status === 'done') return <span className={cx(ui.chip, ui.sage)}>Done · {done}/{total}</span>;
  if (status === 'review') return <span className={cx(ui.chip, ui.butter)}>Check the drawings</span>;
  if (status === 'character') return <span className={cx(ui.chip, ui.lilac)}>Drawing people</span>;
  return (
    <span className={cx(ui.chip, ui.sky)}>
      Pages {done}/{total}
    </span>
  );
}
