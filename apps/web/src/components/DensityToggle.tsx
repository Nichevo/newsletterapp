import { useSyncExternalStore } from 'react';
import { DENSITIES, getDensity, getViewOptions, setDensity, subscribeDensity, type Density, type ViewOptions } from '../prefs';
import { IconDensity } from '../icons';

/** The current inbox density, re-rendering when it changes anywhere in the app. */
export function useDensity(): Density {
  return useSyncExternalStore(subscribeDensity, getDensity, () => 'card');
}

/** What the current view shows (preview lines, key points…), live-updated from Settings. */
export function useViewOptions(): ViewOptions {
  return useSyncExternalStore(subscribeDensity, getViewOptions, getViewOptions);
}

/** Cycles compact → card → expanded. Lives in the inbox top bar. */
export function DensityToggle() {
  const density = useDensity();
  const current = DENSITIES.findIndex((d) => d.id === density);
  const next = DENSITIES[(current + 1) % DENSITIES.length] ?? DENSITIES[1]!;
  return (
    <button
      className="iconbtn"
      aria-label={`List view: ${DENSITIES[current]?.label ?? 'Card'}. Switch to ${next.label}`}
      title={`${DENSITIES[current]?.label ?? 'Card'} view · tap for ${next.label}`}
      onClick={() => setDensity(next.id)}
    >
      <IconDensity density={density} />
    </button>
  );
}
