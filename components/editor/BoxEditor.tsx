'use client';

import { useRef, useState, type PointerEvent } from 'react';

import type { Box } from '@/lib/types';

import styles from './BoxEditor.module.css';

type Drag =
  | { mode: 'draw'; x: number; y: number }
  | { mode: 'move'; dx: number; dy: number }
  | { mode: 'resize'; corner: 'nw' | 'ne' | 'sw' | 'se'; start: Box };

const MIN = 2;
const clamp = (n: number, lo = 0, hi = 100) => Math.min(Math.max(n, lo), hi);
const round = (b: Box): Box => ({ x: +b.x.toFixed(2), y: +b.y.toFixed(2), w: +b.w.toFixed(2), h: +b.h.toFixed(2) });
const at = (b: Box) => ({ left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`, height: `${b.h}%` });

interface Props {
  box: Box | null;
  label: string;
  onChange: (box: Box | null) => void;
  /** Other characters' boxes on this page, shown faintly for orientation. */
  others?: { label: string; box: Box }[];
}

/** Draw, move and resize one character's box over the illustration. Coordinates are % of the art. */
export function BoxEditor({ box, label, onChange, others = [] }: Props) {
  const layer = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [live, setLive] = useState<Box | null>(null);
  const shown = live ?? box;

  const point = (e: PointerEvent) => {
    const r = layer.current!.getBoundingClientRect();
    return { x: clamp(((e.clientX - r.left) / r.width) * 100), y: clamp(((e.clientY - r.top) / r.height) * 100) };
  };

  function start(e: PointerEvent, next: Drag) {
    e.preventDefault();
    e.stopPropagation();
    layer.current!.setPointerCapture(e.pointerId);
    drag.current = next;
  }

  function move(e: PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const p = point(e);
    if (d.mode === 'draw') {
      setLive({ x: Math.min(d.x, p.x), y: Math.min(d.y, p.y), w: Math.abs(p.x - d.x), h: Math.abs(p.y - d.y) });
    } else if (d.mode === 'move' && box) {
      setLive({ ...box, x: clamp(p.x - d.dx, 0, 100 - box.w), y: clamp(p.y - d.dy, 0, 100 - box.h) });
    } else if (d.mode === 'resize') {
      const s = d.start;
      const left = d.corner.includes('w') ? Math.min(p.x, s.x + s.w - MIN) : s.x;
      const right = d.corner.includes('e') ? Math.max(p.x, s.x + MIN) : s.x + s.w;
      const top = d.corner.includes('n') ? Math.min(p.y, s.y + s.h - MIN) : s.y;
      const bottom = d.corner.includes('s') ? Math.max(p.y, s.y + MIN) : s.y + s.h;
      setLive({ x: left, y: top, w: right - left, h: bottom - top });
    }
  }

  function end() {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (live && (d.mode !== 'draw' || (live.w >= MIN && live.h >= MIN))) onChange(round(live));
    setLive(null);
  }

  return (
    <div
      ref={layer}
      className={styles.layer}
      onPointerDown={(e) => {
        const p = point(e);
        start(e, { mode: 'draw', x: p.x, y: p.y });
      }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {others.map((o) => (
        <div key={o.label} className={styles.other} style={at(o.box)}>
          <span className={styles.otherLabel}>{o.label}</span>
        </div>
      ))}
      {shown && (
        <div
          className={styles.box}
          style={at(shown)}
          onPointerDown={(e) => {
            if (!box) return;
            const p = point(e);
            start(e, { mode: 'move', dx: p.x - box.x, dy: p.y - box.y });
          }}
        >
          <span className={styles.label}>{label}</span>
          {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
            <span
              key={corner}
              className={`${styles.handle} ${styles[corner]}`}
              onPointerDown={(e) => box && start(e, { mode: 'resize', corner, start: box })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
