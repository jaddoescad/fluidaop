import { useFluid } from './useFluid';
import { FleetV } from './variants/Fleet';

export default function App() {
  const { s, act } = useFluid();

  if (!s.booted) return <div className="boot" />;

  return <FleetV s={s} act={act} />;
}
