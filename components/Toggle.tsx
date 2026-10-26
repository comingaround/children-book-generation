import ui from './ui.module.css';

/** A switch row: label and help on the left, the switch on the right. */
export function Toggle({ label, help, checked, onChange }: { label: string; help?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={ui.switchRow}>
      <span className={ui.switchText}>
        {label}
        {help && <span className={ui.help}>{help}</span>}
      </span>
      <input type="checkbox" className={ui.switch} checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
