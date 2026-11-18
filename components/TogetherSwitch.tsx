import { cx } from '@/lib/client';

import ui from './ui.module.css';

/** How a page with several people is drawn: one image per character, or one for everyone. */
export function TogetherSwitch({ together, onChange, className }: { together: boolean; onChange: (together: boolean) => void; className?: string }) {
  return (
    <div className={cx(ui.segmented, className)} role="group" aria-label="How characters on a page are drawn">
      <button className={ui.segment} aria-pressed={!together} onClick={() => onChange(false)} title="One image per character, each drawn on top of the last: only if faces get mixed up; drifts more, costs more">
        One by one
      </button>
      <button className={ui.segment} aria-pressed={together} onClick={() => onChange(true)} title="One image per page for everyone: closest to the original, cheaper (default)">
        All at once
      </button>
    </div>
  );
}
