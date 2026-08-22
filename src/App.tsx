import { useState } from 'react';
import { useFluid } from './useFluid';
import { ArcadeV } from './variants/Arcade';
import { GroveV } from './variants/Grove';
import { PulseV } from './variants/Pulse';

const VARIANTS = [
  { key: 'pulse', name: 'Pulse', blurb: 'neon intent wall', C: PulseV },
  { key: 'arcade', name: 'Arcade', blurb: 'game HUD', C: ArcadeV },
  { key: 'grove', name: 'Grove', blurb: 'tend the garden', C: GroveV },
] as const;

export default function App() {
  const { s, act } = useFluid();
  const [vi, setVi] = useState(0);

  if (!s.booted) return <div className="boot" />;

  const variant = VARIANTS[vi] ?? VARIANTS[0];
  const V = variant.C;

  return (
    <>
      <V s={s} act={act} />
      <nav className="dock" aria-label="UI variant switcher">
        {VARIANTS.map((v, i) => (
          <button
            key={v.key}
            className={`dock-btn${i === vi ? ' on' : ''}`}
            onClick={() => setVi(i)}
            title={`${v.name} — ${v.blurb}`}
          >
            <b>{String(i + 1).padStart(2, '0')}</b>
            <span className="dock-name">{v.name}</span>
            <em>{v.blurb}</em>
          </button>
        ))}
      </nav>
    </>
  );
}
