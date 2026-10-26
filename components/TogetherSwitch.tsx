import { cx } from '@/lib/client';

import ui from './ui.module.css';

/** How a page with several people is drawn: one image per character, or one for everyone. */
export function TogetherSwitch({ together, onChange, className }: { together: boolean; onChange: (together: boolean) => void; className?: string }) {
  return (
    <div className={cx(ui.segmented, className)} role="group" aria-label="How characters on a page are drawn">
      <button className={ui.segment} aria-pressed={!together} onClick={() => onChange(false)} title="One image per character: best detail">
        One by one
      </button>
      <button className={ui.segment} aria-pressed={together} onClick={() => onChange(true)} title="One image per page for everyone: cheaper, faces smaller">
        All at once
      </button>
    </div>
  );
}
