/**
 * Tests of the damage and build tab of the match page, rendered on their own with views built by
 * hand (the view the breakdown service gives is tested with the service), in English and in French.
 *
 * The page reads the view through the services of the app, so each test gives the service the view it
 * wants to show: the tab, its hook, the query client and the translations are the real ones. The
 * numbers are synthetic and chosen so that each one is told from the others in the page. The build
 * is rendered by the tab, so its tests are here too.
 *
 * @packageDocumentation
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, type MockInstance } from 'vitest';
import type { DamageBreakdown, DamageSourceRow } from '../../../core/analysis/damage-breakdown';
import { AppError } from '../../../core/errors/app-error';
import type { Language } from '../../../core/settings/language';
import type { AppServices } from '../../../services/app-services';
import type { BuildItemView, DamageTabView } from '../../../services/match-breakdown.service';
import { createTestQueryClient, createTestServices } from '../../../test/create-test-services';
import { testMatchId } from '../../../test/test-data';
import { AppProviders } from '../../app/AppProviders';
import { createI18n } from '../../i18n/i18n';
import { INSIGHT_STYLE } from './analysis-format';
import { DamageTab } from './DamageTab';

/** The match of the tests. */
const MATCH_ID = testMatchId(100_000_001);

/** The minus sign the page writes before a negative number. */
const MINUS = '−';

/** The name of the list of the sources, as the page says it in English: the title of its section. */
const DAMAGE_TITLE_EN = 'Your damage to heroes, by source';

/** The title of the build, as the page says it in English. */
const BUILD_TITLE_EN = 'Your final build';

/** Where the images of the catalogues live: the one origin the app lets the page load pictures from. */
const IMAGE_ORIGIN = 'https://assets-bucket.deadlock-api.com/';

/**
 * Build the row of a damage source: an ability that dealt a tenth of the damage, as it usually does,
 * unless overridden.
 *
 * @param overrides - Fields to change.
 * @returns The row.
 */
function testRow(overrides: Partial<DamageSourceRow> = {}): DamageSourceRow {
  return {
    className: 'citadel_ability_rallying_charge',
    kind: 'ability',
    itemId: 2_000_001,
    name: 'Rallying Charge',
    imageUrl: `${IMAGE_ORIGIN}abilities/rallying-charge.webp`,
    damage: 1_000,
    share: 0.1,
    comparedShare: 0.1,
    habit: { median: 0.1, count: 12 },
    gap: 0,
    flag: null,
    unlocked: true,
    ...overrides,
  };
}

/**
 * The rows of a match, in the order the service gives them: the sources that were unlocked by share,
 * then the ability that was not. Their damage adds up to 10,000, and their shares to 100 %.
 */
function testRows(): DamageSourceRow[] {
  return [
    testRow({
      className: 'citadel_weapon_primary',
      kind: 'weapon',
      itemId: 2_000_010,
      name: 'Express Shot',
      imageUrl: `${IMAGE_ORIGIN}weapons/express-shot.webp`,
      damage: 4_600,
      share: 0.46,
      comparedShare: 0.46,
      habit: { median: 0.44, count: 12 },
      gap: 0.02,
    }),
    testRow({
      className: 'citadel_ability_bookwyrm',
      itemId: 2_000_011,
      name: 'Bookwyrm',
      damage: 3_000,
      share: 0.3,
      comparedShare: 0.3,
      habit: { median: 0.22, count: 20 },
      gap: 0.08,
      flag: 'above',
    }),
    // An item has its habit and its gap on its share while it was owned: 31 % of what was dealt while
    // the player had it, which is 12 % of the whole match.
    testRow({
      className: 'upgrade_mystic_burst',
      kind: 'item',
      itemId: 2_000_012,
      name: 'Mystic Burst',
      imageUrl: `${IMAGE_ORIGIN}items/mystic-burst.webp`,
      damage: 1_200,
      share: 0.12,
      comparedShare: 0.31,
      habit: { median: 0.25, count: 7 },
      gap: 0.06,
    }),
    testRow({
      damage: 800,
      share: 0.08,
      comparedShare: 0.08,
      habit: { median: 0.18, count: 20 },
      gap: -0.1,
      flag: 'below',
    }),
    // The melee attack has no picture in the catalogue: a neutral square takes its place.
    testRow({
      className: 'citadel_weapon_melee',
      kind: 'melee',
      itemId: 2_000_013,
      name: 'Heavy Melee',
      imageUrl: null,
      damage: 300,
      share: 0.03,
      comparedShare: 0.03,
      habit: { median: 0.05, count: 12 },
      gap: -0.02,
    }),
    // A source that is neither the hero's nor a shop item (a zip line knock-off, say).
    testRow({
      className: 'citadel_ability_zip_line',
      kind: 'other',
      itemId: null,
      name: 'Zip Line',
      imageUrl: null,
      damage: 100,
      share: 0.01,
      comparedShare: 0.01,
      habit: null,
      gap: null,
    }),
    testRow({
      className: 'citadel_ability_chapters_end',
      itemId: 2_000_014,
      name: "Chapter's End",
      damage: 0,
      share: 0,
      comparedShare: null,
      habit: null,
      gap: null,
      unlocked: false,
    }),
  ];
}

/**
 * Build the damage breakdown of a match.
 *
 * @param rows - The rows, in the order the service gives them.
 * @returns The breakdown, whose total is the damage of the rows.
 */
function testBreakdown(rows: readonly DamageSourceRow[] = testRows()): DamageBreakdown {
  return { totalDamage: rows.reduce((total, row) => total + row.damage, 0), rows };
}

/**
 * Build an item of the final build: a tier 1 weapon item bought two minutes into the match, unless
 * overridden.
 *
 * @param overrides - Fields to change.
 * @returns The item.
 */
function testBuildItem(overrides: Partial<BuildItemView> = {}): BuildItemView {
  return {
    itemId: 3_000_001,
    name: 'Basic Magazine',
    imageUrl: `${IMAGE_ORIGIN}items/basic-magazine.webp`,
    slot: 'weapon',
    tier: 1,
    boughtAtS: 120,
    imbuedInto: null,
    ...overrides,
  };
}

/**
 * The final build of the tests, in the order the service gives it: by slot, with one item the
 * catalogue does not know (it keeps no slot and no name).
 */
function testBuild(): BuildItemView[] {
  return [
    testBuildItem(),
    testBuildItem({ itemId: 3_000_002, name: 'Close Quarters', tier: 2, boughtAtS: 610 }),
    testBuildItem({
      itemId: 3_000_003,
      name: 'Extra Health',
      imageUrl: null,
      slot: 'vitality',
      boughtAtS: 305,
    }),
    testBuildItem({
      itemId: 3_000_004,
      name: 'Mystic Reach',
      slot: 'spirit',
      boughtAtS: 725,
      imbuedInto: 'Bookwyrm',
    }),
    testBuildItem({
      itemId: 4_000_099,
      name: null,
      imageUrl: null,
      slot: null,
      tier: null,
      boughtAtS: 61,
    }),
  ];
}

/**
 * Build a view that is ready.
 *
 * @param breakdown - The damage by source; the rows of the tests by default.
 * @param build - The final build; the build of the tests by default.
 * @returns The view.
 */
function readyView(
  breakdown: DamageBreakdown | null = testBreakdown(),
  build: readonly BuildItemView[] = testBuild(),
): DamageTabView {
  return { kind: 'ready', breakdown, build };
}

/** What a render of the tab gives back to a test. */
interface Rendered {
  /** The root of the render: empty when the tab shows nothing. */
  readonly container: HTMLElement;
  /** The spy on the service call that gives the view. */
  readonly read: MockInstance<AppServices['breakdown']['getDamageTab']>;
}

/**
 * Render the tab for a match whose damage view is the one given, and wait until it has been read.
 *
 * @param view - The view the service gives, or the error it fails with.
 * @param language - The language of the interface; English by default.
 * @returns The root of the render and the spy on the service.
 */
async function renderDamageTab(
  view: DamageTabView | AppError,
  language: Language = 'en',
): Promise<Rendered> {
  const { services } = createTestServices();
  const read = vi.spyOn(services.breakdown, 'getDamageTab');
  if (view instanceof AppError) {
    read.mockRejectedValue(view);
  } else {
    read.mockResolvedValue(view);
  }
  const queryClient = createTestQueryClient();
  const i18n = await createI18n(language);
  const { container } = render(
    <AppProviders services={services} queryClient={queryClient} i18n={i18n}>
      <DamageTab matchId={MATCH_ID} />
    </AppProviders>,
  );
  // The view is read from the service, so it comes a moment after the first render.
  await waitFor(() => {
    expect(read).toHaveBeenCalledWith(MATCH_ID);
    expect(queryClient.isFetching()).toBe(0);
  });
  return { container, read };
}

/**
 * Find the list of the damage sources.
 *
 * @param title - The title of its section, which names it.
 * @returns The list.
 */
function damageList(title: string = DAMAGE_TITLE_EN): HTMLElement {
  return screen.getByRole('list', { name: title });
}

/**
 * Find the row of a damage source.
 *
 * @param name - The name of the source, as the page says it.
 * @param title - The title of the section, which names the list.
 * @returns The item of the list of the damage sources.
 */
function rowOf(name: string, title: string = DAMAGE_TITLE_EN): HTMLElement {
  return (
    within(damageList(title)).getByText(name).closest('li') ??
    expect.unreachable(`No row is named ${name}`)
  );
}

/**
 * Find the names of the rows of the damage list, in the order they are shown.
 *
 * @returns The name of each row: the first line of its source cell.
 */
function rowNames(): (string | null | undefined)[] {
  return within(damageList())
    .getAllByRole('listitem')
    .map((row) => row.querySelector('p')?.textContent);
}

/**
 * Find the evidence panel of a row.
 *
 * @param row - The row.
 * @returns The panel.
 */
function panelOf(row: HTMLElement): HTMLElement {
  return within(row).getByRole('tooltip');
}

/**
 * Split the texts found in a row between the ones the row shows and the ones of its evidence panel
 * (which says some of them again).
 *
 * @param elements - The elements found in a row.
 * @returns The ones outside the panel and the ones inside it.
 */
function splitByPanel(elements: readonly HTMLElement[]): {
  outside: HTMLElement[];
  inside: HTMLElement[];
} {
  const isInPanel = (element: HTMLElement) => element.closest('[role="tooltip"]') !== null;
  return {
    outside: elements.filter((element) => !isInPanel(element)),
    inside: elements.filter(isInPanel),
  };
}

/**
 * Find the parts of the bar of a row: the fill that draws the share and the mark of the habit.
 *
 * @param row - The row.
 * @returns The fill, and the mark when the row has one. Both are the elements with a style of their
 *   own: the bar is the one place that no class can hold a width or a position.
 */
function barOf(row: HTMLElement): { fill: Element | undefined; mark: Element | undefined } {
  const [fill, mark] = Array.from(row.querySelectorAll('[style]'));
  return { fill, mark };
}

/**
 * Find the names of the items of a group of the build, in the order they are shown.
 *
 * @param group - The name of the slot group, as the page says it.
 * @returns The name of each item: the first line of the item.
 */
function buildNames(group: string): (string | null | undefined)[] {
  return within(screen.getByRole('list', { name: group }))
    .getAllByRole('listitem')
    .map((item) => item.querySelector('p')?.textContent);
}

describe('DamageTab', () => {
  it('lists the sources by share with their usual share and gap', async () => {
    await renderDamageTab(readyView());

    // The title of the section and the total of the damage, which the shares are shares of.
    expect(screen.getByRole('heading', { level: 2, name: DAMAGE_TITLE_EN })).toBeInTheDocument();
    expect(screen.getByText('10,000 in all')).toBeInTheDocument();
    // The rows keep the order of the service, which is by share with the abilities not unlocked last.
    const items = within(damageList()).getAllByRole('listitem');
    const names = [
      'Express Shot',
      'Bookwyrm',
      'Mystic Burst',
      'Rallying Charge',
      'Heavy Melee',
      'Zip Line',
      "Chapter's End",
    ];
    expect(items).toEqual(names.map((name) => rowOf(name)));
    // The share of the match, the usual one and the gap, in points.
    const weapon = within(rowOf('Express Shot'));
    expect(weapon.getByText('46%')).toBeInTheDocument();
    expect(weapon.getByText('44%')).toBeInTheDocument();
    expect(weapon.getByText('+2 pts')).toBeInTheDocument();
    const melee = within(rowOf('Heavy Melee'));
    expect(melee.getByText('3%')).toBeInTheDocument();
    expect(melee.getByText('5%')).toBeInTheDocument();
    expect(melee.getByText(`${MINUS}2 pts`)).toBeInTheDocument();
    // The weapon, the melee and the items say what they are; an ability or any other source needs no
    // word.
    expect(weapon.getByText('Weapon')).toBeInTheDocument();
    expect(melee.getByText('Melee')).toBeInTheDocument();
    expect(within(rowOf('Mystic Burst')).getByText('Item')).toBeInTheDocument();
    for (const name of ['Bookwyrm', 'Zip Line']) {
      expect(within(rowOf(name)).queryByText(/^(Weapon|Melee|Item)$/)).not.toBeInTheDocument();
    }
  });

  it('shows the share of the match for every source, so that the shares add up to 100 %', async () => {
    await renderDamageTab(readyView());

    // The item is on the share of the match too (12 %), not on its share while owned (31 %). The
    // share is the first figure of a row, before the usual share.
    const shares = [
      'Express Shot',
      'Bookwyrm',
      'Mystic Burst',
      'Rallying Charge',
      'Heavy Melee',
      'Zip Line',
    ]
      .map((name) => within(rowOf(name)).getAllByText(/^\d+%$/, { selector: 'p' })[0]?.textContent)
      // The text of a figure starts with the name of its column, for assistive technologies.
      .map((text) => Number.parseInt(/\d+/.exec(text ?? '')?.[0] ?? '', 10));
    expect(shares).toEqual([46, 30, 12, 8, 3, 1]);
    expect(shares.reduce((total, share) => total + share, 0)).toBe(100);
  });

  it('draws the share as a bar with a mark at the usual share', async () => {
    await renderDamageTab(readyView());

    const weapon = barOf(rowOf('Express Shot'));
    expect(weapon.fill).toHaveStyle({ width: '46%' });
    expect(weapon.mark).toHaveStyle({ left: '44%' });
    // An item's habit is on its share while it was owned, not on the share of the match the bar
    // draws: the bar has no mark for it.
    const item = barOf(rowOf('Mystic Burst'));
    expect(item.fill).toHaveStyle({ width: '12%' });
    expect(item.mark).toBeUndefined();
    // The bar is for the eye: the numbers are in the cells.
    expect(weapon.fill?.parentElement).toHaveAttribute('aria-hidden', 'true');
  });

  it('marks the sources below and above their habits with a word', async () => {
    await renderDamageTab(readyView());

    const above = rowOf('Bookwyrm');
    const aboveWord = within(above).getByText('More than usual');
    // The word is on screen, with an arrow and the colours of a strength: the colour never says it alone.
    expect(aboveWord).toHaveClass(INSIGHT_STYLE.strength.text);
    expect(aboveWord).not.toHaveClass('sr-only');
    expect(aboveWord).toHaveTextContent(`${INSIGHT_STYLE.strength.arrow} More than usual`);
    expect(within(above).getByRole('group').firstElementChild).toHaveClass(
      INSIGHT_STYLE.strength.tint,
    );
    const below = rowOf('Rallying Charge');
    const belowWord = within(below).getByText('Less than usual');
    expect(belowWord).toHaveClass(INSIGHT_STYLE.weakness.text);
    expect(belowWord).not.toHaveClass('sr-only');
    expect(belowWord).toHaveTextContent(`${INSIGHT_STYLE.weakness.arrow} Less than usual`);
    expect(within(below).getByRole('group').firstElementChild).toHaveClass(
      INSIGHT_STYLE.weakness.tint,
    );
    expect(within(below).getByText(`${MINUS}10 pts`)).toBeInTheDocument();
    // A source near its habit carries neither word nor tint.
    const usual = rowOf('Express Shot');
    expect(within(usual).queryByText(/than usual/)).not.toBeInTheDocument();
    const usualRow = within(usual).getByRole('group').firstElementChild;
    expect(usualRow).not.toHaveClass(INSIGHT_STYLE.strength.tint);
    expect(usualRow).not.toHaveClass(INSIGHT_STYLE.weakness.tint);
    expect(screen.getAllByText(/than usual/)).toHaveLength(2);
  });

  it('gives the amount, the usual share and the matches it is made of in the evidence of a row', async () => {
    await renderDamageTab(readyView());

    const panel = within(panelOf(rowOf('Express Shot')));
    expect(panel.getByText('4,600 damage')).toBeInTheDocument();
    expect(panel.getByText('Your median: 44%')).toBeInTheDocument();
    expect(panel.getByText('12 reference matches')).toBeInTheDocument();
    // A row is a group the keyboard reaches, named after its source and described by its panel.
    const group = within(rowOf('Express Shot')).getByRole('group', { name: 'Express Shot' });
    expect(group).toHaveAttribute('tabindex', '0');
    expect(group).toHaveAccessibleDescription(/4,600 damage/);
  });

  it("shows an item's share while owned in its evidence", async () => {
    await renderDamageTab(readyView());

    const item = rowOf('Mystic Burst');
    // Its habit and its gap are on that share, which the row says under the share of the match, and
    // the evidence says again.
    expect(within(item).getByText('25%')).toBeInTheDocument();
    expect(within(item).getByText('+6 pts')).toBeInTheDocument();
    const { outside, inside } = splitByPanel(within(item).getAllByText('31% while you owned it'));
    expect(outside).toHaveLength(1);
    expect(outside[0]).toHaveClass('text-fg-muted');
    expect(inside).toHaveLength(1);
    const panel = within(panelOf(item));
    expect(panel.getByText('1,200 damage')).toBeInTheDocument();
    expect(panel.getByText('Your median: 25%')).toBeInTheDocument();
    expect(panel.getByText('7 reference matches')).toBeInTheDocument();
    // Only an item is compared on that scale.
    expect(screen.getAllByText(/while you owned it/)).toHaveLength(2);
  });

  it('says nothing of the share while owned for an item whose share is not known', async () => {
    // An item the damage matrix cannot place in time has no share while owned, and so no habit to
    // compare it with: the row shows the share of the match alone.
    const rows = [
      testRow({
        className: 'upgrade_mystic_burst',
        kind: 'item',
        itemId: 2_000_012,
        name: 'Mystic Burst',
        damage: 500,
        share: 0.05,
        comparedShare: null,
        habit: null,
        gap: null,
      }),
    ];
    await renderDamageTab(readyView(testBreakdown(rows)));

    const item = rowOf('Mystic Burst');
    // No "while owned" line in the row nor in the evidence, and never a figure made of nothing.
    expect(within(item).queryByText(/while you owned it/)).not.toBeInTheDocument();
    expect(item).not.toHaveTextContent(/null|NaN|undefined/);
    expect(within(item).getByText('5%')).toBeInTheDocument();
    const panel = within(panelOf(item));
    expect(panel.getByText('500 damage')).toBeInTheDocument();
    expect(panel.getByText('Not enough matches yet')).toBeInTheDocument();
  });

  it('shows a dash and what is missing in the evidence of a source with no usual share', async () => {
    const rows = [testRow({ habit: null, gap: null, flag: null })];
    await renderDamageTab(readyView(testBreakdown(rows)));

    const row = rowOf('Rallying Charge');
    // No usual share, no gap and no mark: the bar draws the share alone.
    expect(within(row).getAllByText('—')).toHaveLength(2);
    expect(barOf(row).mark).toBeUndefined();
    expect(barOf(row).fill).toHaveStyle({ width: '10%' });
    const panel = within(panelOf(row));
    expect(panel.getByText('Not enough matches yet')).toBeInTheDocument();
    expect(panel.queryByText(/reference matches/)).not.toBeInTheDocument();
  });

  it('shows the abilities not unlocked last', async () => {
    await renderDamageTab(readyView());

    const items = within(damageList()).getAllByRole('listitem');
    const last = items.at(-1) ?? expect.unreachable('The list holds rows');
    expect(within(last).getByText("Chapter's End")).toBeInTheDocument();
    // It says so instead of a share, and has no bar, no mark, no flag and nothing to compare.
    expect(within(last).getByText('Not unlocked')).toBeInTheDocument();
    expect(last.querySelector('[style]')).toBeNull();
    expect(within(last).queryByText(/than usual/)).not.toBeInTheDocument();
    expect(within(last).queryByText('0%')).not.toBeInTheDocument();
    // Its two dashes are figures of the habit and gap columns, and say so to assistive technologies.
    const dashes = within(last).getAllByText('—');
    expect(dashes).toHaveLength(2);
    expect(within(last).getByText('Usually')).toHaveClass('sr-only');
    expect(within(last).getByText('Gap')).toHaveClass('sr-only');
    expect(dashes.map((dash) => dash.textContent)).toEqual(['Usually —', 'Gap —']);
    expect(dashes[0]).toHaveClass('text-fg-muted');
  });

  it('keeps the order of the service for the sources, whatever their shares', async () => {
    // Not the order a sort by share would give: a small share before a large one, and an ability that
    // was not unlocked in the middle. The service decides the order; the tab shows it as it is.
    const rows = [
      testRow({ name: 'Small', className: 'small', share: 0.08, comparedShare: 0.08 }),
      testRow({ name: 'Large', className: 'large', share: 0.46, comparedShare: 0.46 }),
      testRow({
        name: 'Locked',
        className: 'locked',
        share: 0,
        comparedShare: null,
        habit: null,
        gap: null,
        unlocked: false,
      }),
      testRow({ name: 'Medium', className: 'medium', share: 0.3, comparedShare: 0.3 }),
    ];
    await renderDamageTab(readyView(testBreakdown(rows)));

    expect(rowNames()).toEqual(['Small', 'Large', 'Locked', 'Medium']);
  });

  it('shows the picture of a source, and a neutral square when it has none', async () => {
    await renderDamageTab(readyView());

    const weapon = rowOf('Express Shot').querySelector('img');
    // The picture is decorative: the name is written beside it. Its size is given so that the row
    // does not move when it arrives.
    expect(weapon).toHaveAttribute('src', `${IMAGE_ORIGIN}weapons/express-shot.webp`);
    expect(weapon).toHaveAttribute('alt', '');
    expect(weapon).toHaveAttribute('width');
    expect(weapon).toHaveAttribute('height');
    expect(rowOf('Heavy Melee').querySelector('img')).toBeNull();
  });

  it('puts a neutral square in place of the picture of a source that fails to load', async () => {
    await renderDamageTab(readyView());

    const row = rowOf('Express Shot');
    // The pictures live on a remote bucket: offline, the browser would show its broken-image icon.
    fireEvent.error(row.querySelector('img') ?? expect.unreachable('The row shows a picture'));

    expect(row.querySelector('img')).toBeNull();
    // The square keeps the room of the picture, so that the names of the rows stay lined up; the
    // square of a source that has no picture is the same one.
    expect(row.querySelector('span.size-8[aria-hidden="true"]')).not.toBeNull();
    expect(rowOf('Heavy Melee').querySelector('span.size-8[aria-hidden="true"]')).not.toBeNull();
    // The name is still there, and the other rows keep their pictures.
    expect(within(row).getByText('Express Shot')).toBeInTheDocument();
    expect(rowOf('Mystic Burst').querySelector('img')).not.toBeNull();
  });

  it('groups the final build by slot', async () => {
    await renderDamageTab(readyView());

    expect(screen.getByRole('heading', { level: 2, name: BUILD_TITLE_EN })).toBeInTheDocument();
    // One group for each slot that holds an item, in the order of the shop, with the other items last.
    expect(screen.getAllByRole('heading', { level: 3 }).map((title) => title.textContent)).toEqual([
      'Weapon',
      'Vitality',
      'Spirit',
      'Other',
    ]);
    const weapon = within(screen.getByRole('list', { name: 'Weapon' }));
    expect(buildNames('Weapon')).toEqual(['Basic Magazine', 'Close Quarters']);
    // Each item says when it was bought, as minutes and seconds.
    expect(weapon.getByText('bought at 2:00')).toBeInTheDocument();
    expect(weapon.getByText('bought at 10:10')).toBeInTheDocument();
    expect(buildNames('Vitality')).toEqual(['Extra Health']);
    // The ability an item was imbued into is named.
    const spirit = within(screen.getByRole('list', { name: 'Spirit' }));
    expect(spirit.getByText('Mystic Reach')).toBeInTheDocument();
    expect(spirit.getByText('bought at 12:05')).toBeInTheDocument();
    expect(spirit.getByText('imbued into Bookwyrm')).toBeInTheDocument();
    expect(weapon.queryByText(/imbued into/)).not.toBeInTheDocument();
  });

  it('keeps the order of the service for the items of the build, whatever their tier or time', async () => {
    // Not the order a sort would give: a tier 2 item before a tier 1 one, and a later purchase before
    // an earlier one. The groups follow the slots of the shop whatever the order of the items.
    const build = [
      testBuildItem({ itemId: 3_000_005, name: 'Late Health', slot: 'vitality', boughtAtS: 900 }),
      testBuildItem({ itemId: 3_000_002, name: 'Close Quarters', tier: 2, boughtAtS: 610 }),
      testBuildItem({ itemId: 3_000_003, name: 'Early Health', slot: 'vitality', boughtAtS: 300 }),
      testBuildItem({ itemId: 3_000_001, name: 'Basic Magazine', tier: 1, boughtAtS: 120 }),
    ];
    await renderDamageTab(readyView(testBreakdown(), build));

    expect(screen.getAllByRole('heading', { level: 3 }).map((title) => title.textContent)).toEqual([
      'Weapon',
      'Vitality',
    ]);
    expect(buildNames('Weapon')).toEqual(['Close Quarters', 'Basic Magazine']);
    expect(buildNames('Vitality')).toEqual(['Late Health', 'Early Health']);
  });

  it('shows an item the catalogue does not know by its id, in the group of the other items', async () => {
    await renderDamageTab(readyView());

    const other = within(screen.getByRole('list', { name: 'Other' }));
    expect(other.getByText('#4000099')).toBeInTheDocument();
    expect(other.getByText('bought at 1:01')).toBeInTheDocument();
  });

  it('shows the picture of an item of the build, and a neutral square when it has none', async () => {
    await renderDamageTab(readyView());

    const weapon = within(screen.getByRole('list', { name: 'Weapon' }));
    const [first] = weapon.getAllByRole('listitem');
    expect(first?.querySelector('img')).toHaveAttribute(
      'src',
      `${IMAGE_ORIGIN}items/basic-magazine.webp`,
    );
    const vitality = within(screen.getByRole('list', { name: 'Vitality' }));
    expect(vitality.getByRole('listitem').querySelector('img')).toBeNull();
  });

  it('puts a neutral square in place of the picture of an item that fails to load', async () => {
    await renderDamageTab(readyView());

    const weapon = within(screen.getByRole('list', { name: 'Weapon' }));
    const [first, second] = weapon.getAllByRole('listitem');
    if (first === undefined || second === undefined) {
      expect.unreachable('The weapon slot holds two items');
    }
    fireEvent.error(first.querySelector('img') ?? expect.unreachable('The item shows a picture'));

    // The item keeps its place, its name and the room of its picture; the browser's broken-image icon
    // is gone, and the other items keep their pictures.
    expect(first.querySelector('img')).toBeNull();
    expect(first.querySelector('span.size-8[aria-hidden="true"]')).not.toBeNull();
    expect(within(first).getByText('Basic Magazine')).toBeInTheDocument();
    expect(second.querySelector('img')).not.toBeNull();
  });

  it('titles the build at the level of the damage, and its slots one level under', async () => {
    await renderDamageTab(readyView());

    // The two regions are peers: a screen reader's list of headings must not nest the build under the
    // damage.
    const levelsByTitle = screen
      .getAllByRole('heading')
      .map((heading) => [heading.textContent, heading.tagName] as const);
    expect(levelsByTitle).toEqual([
      [DAMAGE_TITLE_EN, 'H2'],
      [BUILD_TITLE_EN, 'H2'],
      ['Weapon', 'H3'],
      ['Vitality', 'H3'],
      ['Spirit', 'H3'],
      ['Other', 'H3'],
    ]);
  });

  it('has a region for the damage and one for the build, and no region for a slot of the build', async () => {
    await renderDamageTab(readyView());

    const damage = screen.getByRole('region', { name: DAMAGE_TITLE_EN });
    const build = screen.getByRole('region', { name: BUILD_TITLE_EN });
    expect(screen.getAllByRole('region')).toEqual([damage, build]);
    // The damage region holds the damage only, and the build its own.
    expect(within(damage).queryByText('Basic Magazine')).not.toBeInTheDocument();
    expect(within(damage).queryByRole('heading', { name: BUILD_TITLE_EN })).not.toBeInTheDocument();
    expect(within(build).getByText('Basic Magazine')).toBeInTheDocument();
    // A slot is a titled list of its own, not a region.
    expect(within(build).getByRole('list', { name: 'Weapon' })).toBeInTheDocument();
  });

  it('says so when the match ends with no item', async () => {
    await renderDamageTab(readyView(testBreakdown(), []));

    expect(screen.getByRole('heading', { level: 2, name: BUILD_TITLE_EN })).toBeInTheDocument();
    expect(screen.getByText('No item at the end of the match.')).toBeInTheDocument();
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
  });

  it('shows the build under the sentence of a match with no damage to show', async () => {
    await renderDamageTab(readyView(null));

    expect(screen.getByRole('heading', { level: 2, name: DAMAGE_TITLE_EN })).toBeInTheDocument();
    expect(screen.getByText('No damage detail for this match.')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: DAMAGE_TITLE_EN })).not.toBeInTheDocument();
    expect(screen.queryByText(/in all/)).not.toBeInTheDocument();
    expect(screen.getByText('Basic Magazine')).toBeInTheDocument();
  });

  it.each([
    { kind: 'failed', sentence: 'This match could not be analysed.' },
    { kind: 'unreadable', sentence: 'The archive of this match could not be read.' },
    {
      kind: 'catalogue_unavailable',
      sentence: 'Ability and item names are not available for now.',
    },
  ] as const)('shows the sentence of each state: $kind', async ({ kind, sentence }) => {
    await renderDamageTab({ kind });

    expect(screen.getByText(sentence)).toBeInTheDocument();
    // There is nothing else to show: no title, no table, no build.
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it.each(['pending', 'not_analysed'] as const)(
    'shows nothing while the match is %s: the analysis above says why',
    async (kind) => {
      const { container, read } = await renderDamageTab({ kind });

      // The view was read, and it is the view that says there is nothing to show.
      expect(read).toHaveBeenCalledTimes(1);
      await expect(read.mock.results[0]?.value).resolves.toEqual({ kind });
      expect(container).toBeEmptyDOMElement();
    },
  );

  it('says why the tab could not be read when the service fails', async () => {
    await renderDamageTab(new AppError('storage', 'The database failed'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Local data could not be read or saved.',
    );
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('shows the French labels', async () => {
    const rows = [
      ...testRows(),
      // An ability that was unlocked and dealt nothing, with too few matches to have a habit.
      testRow({
        className: 'citadel_ability_no_habit',
        name: 'Rend',
        damage: 0,
        share: 0,
        comparedShare: 0,
        habit: null,
        gap: null,
      }),
    ];
    await renderDamageTab(readyView(testBreakdown(rows)), 'fr');

    const title = 'Tes dégâts aux héros, par source';
    expect(screen.getByRole('heading', { level: 2, name: title })).toBeInTheDocument();
    expect(screen.getByText('10 000 au total')).toBeInTheDocument();
    // The kinds, the shares and the gaps, with the conventions of French.
    expect(within(rowOf('Express Shot', title)).getByText('Arme')).toBeInTheDocument();
    expect(within(rowOf('Heavy Melee', title)).getByText('Mêlée')).toBeInTheDocument();
    expect(within(rowOf('Mystic Burst', title)).getByText('Objet')).toBeInTheDocument();
    expect(within(rowOf('Express Shot', title)).getByText('46 %')).toBeInTheDocument();
    expect(within(rowOf('Rallying Charge', title)).getByText(`${MINUS}10 pts`)).toBeInTheDocument();
    expect(within(rowOf('Bookwyrm', title)).getByText("Plus que d'habitude")).toBeInTheDocument();
    expect(
      within(rowOf('Rallying Charge', title)).getByText("Moins que d'habitude"),
    ).toBeInTheDocument();
    expect(within(rowOf("Chapter's End", title)).getByText('Non débloquée')).toBeInTheDocument();
    // The item: the share of the match, then its share while owned, in the row and in the evidence.
    const item = rowOf('Mystic Burst', title);
    expect(within(item).getByText('12 %')).toBeInTheDocument();
    expect(within(item).getAllByText("31 % pendant que tu l'avais")).toHaveLength(2);
    const panel = within(panelOf(item));
    expect(panel.getByText('1 200 dégâts')).toBeInTheDocument();
    expect(panel.getByText('Ta médiane : 25 %')).toBeInTheDocument();
    expect(
      within(panelOf(rowOf('Rend', title))).getByText('Pas encore assez de parties'),
    ).toBeInTheDocument();
    // The build.
    expect(screen.getByRole('heading', { level: 2, name: 'Ton build final' })).toBeInTheDocument();
    expect(
      screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(['Arme', 'Vitalité', 'Esprit', 'Autres']);
    expect(screen.getByText('acheté à 2:00')).toBeInTheDocument();
    expect(screen.getByText('imprégné dans Bookwyrm')).toBeInTheDocument();
    // The names of the game stay in English.
    expect(screen.getByText('Basic Magazine')).toBeInTheDocument();
  });

  it.each([
    { kind: 'failed', sentence: "Cette partie n'a pas pu être analysée." },
    { kind: 'unreadable', sentence: "L'archive de cette partie n'a pas pu être lue." },
    {
      kind: 'catalogue_unavailable',
      sentence: "Les noms des compétences et des objets ne sont pas disponibles pour l'instant.",
    },
  ] as const)('shows the French sentence of the state $kind', async ({ kind, sentence }) => {
    await renderDamageTab({ kind }, 'fr');

    expect(screen.getByText(sentence)).toBeInTheDocument();
  });
});
