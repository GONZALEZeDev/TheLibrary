/**
 * The Paige page: everything about the hero the app is built around, laid out like the game's hero
 * card.
 *
 * From back to front: the backdrop of her selection screen, her artwork on the full height of the
 * page (anchored to the right, faded into the backdrop), a veil that keeps the left side readable,
 * then her stylised name, her keywords and her stat panels on the left, and her four abilities in
 * spheres, centred at the bottom.
 *
 * The page fills the whole page area: it cancels the margins of `<main>` rather than asking the
 * shell for a special layout.
 *
 * The page shows the game, not a player: it works whether a Steam account is linked or not.
 *
 * @packageDocumentation
 */
import { RotateCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/PageHeader';
import { StatusLine } from '../../components/StatusLine';
import type { PaigePageView } from '../../../services/paige-page.service';
import { AbilityDialog } from './AbilityDialog';
import { AbilityOrbs } from './AbilityOrbs';
import { PaigeArtwork } from './PaigeArtwork';
import { StatPanels } from './StatPanels';
import { usePaigePage } from './use-paige-page';

/** The veil over the left side of the page, from the backdrop colour to transparent. */
const VEIL_STYLE = {
  background:
    'linear-gradient(90deg, color-mix(in srgb, var(--color-bg) 95%, transparent) 0%, color-mix(in srgb, var(--color-bg) 85%, transparent) 45%, transparent 58%)',
};

/** Props of {@link PaigeCard}. */
interface PaigeCardProps {
  readonly page: PaigePageView;
}

/**
 * The page itself, once its data is known.
 *
 * @returns The card: backdrop, artwork, name, keywords, stats and abilities.
 */
function PaigeCard({ page }: PaigeCardProps) {
  const { t } = useTranslation();
  const { hero, stats, abilities } = page;
  // The ability whose window is open, by index; `null` while none is.
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <div className="relative -mx-10 -my-8 flex min-h-screen flex-col overflow-hidden bg-bg">
      {hero.backgroundImageUrl !== null && (
        <img
          src={hero.backgroundImageUrl}
          alt=""
          className="pointer-events-none absolute inset-0 size-full object-cover"
        />
      )}
      <PaigeArtwork fallbackUrl={hero.cardImageUrl} />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={VEIL_STYLE} />
      <div className="relative flex flex-1 flex-col gap-6 px-8 pt-6 pb-6">
        <div className="w-[58%] max-w-[48rem] min-w-[34rem]">
          <h1 className="sr-only">{t('paige.title')}</h1>
          {hero.nameImageUrl !== null ? (
            <img src={hero.nameImageUrl} alt="" className="h-20 w-auto" />
          ) : (
            <p aria-hidden="true" className="font-title text-5xl font-extrabold">
              {hero.name}
            </p>
          )}
          <ul className="mt-3 mb-4 flex flex-wrap gap-2">
            {hero.tags.map((tag) => (
              <li
                key={tag}
                className="rounded bg-accent px-2.5 py-0.5 text-sm font-bold tracking-wide text-white uppercase"
              >
                {tag}
              </li>
            ))}
          </ul>
          <StatPanels stats={stats} />
        </div>
        <div className="mt-auto">
          <AbilityOrbs abilities={abilities} onSelect={setSelected} />
        </div>
        <AbilityDialog
          ability={selected === null ? null : (abilities[selected] ?? null)}
          open={selected !== null}

          onClose={() => {
            setSelected(null);
          }}
        />
      </div>
    </div>
  );
}

/**
 * The Paige page.
 *
 * @returns The loading line, the error with a button to try again, or the page.
 */
export function PaigePage() {
  const { t } = useTranslation();
  const page = usePaigePage();
  if (page.isPending) {
    return (
      <>
        <PageHeader title={t('paige.title')} />
        <StatusLine kind="loading" text={t('paige.loading')} />
      </>
    );
  }
  if (page.data === undefined || page.data === null) {
    return (
      <>
        <PageHeader title={t('paige.title')} />
        {/* A failed query explains its error; a page the cache rules gave no data for (which
            should not happen, as the page does not wait for an account) says it could not load. */}
        {page.data === undefined ? (
          <StatusLine kind="error" error={page.error} />
        ) : (
          <StatusLine kind="alert" text={t('paige.error')} />
        )}
        <div className="mt-3">
          <Button
            look="subtle"
            icon={RotateCw}
            spinning={page.isFetching}
            disabled={page.isFetching}
            onClick={() => {
              void page.refetch();
            }}
          >
            {t('paige.retry')}
          </Button>
        </div>
      </>
    );
  }
  return <PaigeCard page={page.data} />;
}
