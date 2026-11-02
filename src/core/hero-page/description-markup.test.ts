/**
 * Tests of the reading of the descriptions of abilities into safe nodes.
 *
 * @packageDocumentation
 */
import { describe, expect, it } from 'vitest';
import { FIXTURE_PAIGE_ABILITIES } from '../../adapters/dev/fixtures/paige.fixture';
import { parseAbilityDetail } from '../deadlock-api/item-detail.schema';
import { parseDescription } from './description-markup';

const BOOKWYRM = parseAbilityDetail(FIXTURE_PAIGE_ABILITIES.english.ability_bookworm_dragonfire);

describe('parseDescription', () => {
  it("reads Bookwyrm's description, inline icon dropped and keyword kept", () => {
    const nodes = parseDescription(BOOKWYRM.description);

    expect(nodes).toEqual([
      {
        kind: 'text',
        text: 'Conjure a dragon that appears at the target location before flying forward, dealing ',
      },
      { kind: 'keyword', keyword: 'SpiritDamage', text: 'spirit damage' },
      { kind: 'text', text: ' and leaving a burning path in its trail.' },
    ]);
  });

  it('reads the highlights and the line breaks of a tier text', () => {
    const nodes = parseDescription(BOOKWYRM.tierDescriptions[1]);

    expect(nodes.slice(0, 4)).toEqual([
      { kind: 'highlight', text: '+1.0' },
      { kind: 'text', text: ' Charge' },
      { kind: 'break' },
      { kind: 'highlight', text: '+2s' },
    ]);
    // The trailing break of the text is not kept: it would only add an empty line.
    expect(nodes.at(-1)).toEqual({ kind: 'text', text: ' Radius' });
  });

  it('drops a script with its content', () => {
    expect(parseDescription('<script>alert(1)</script>ok')).toEqual([{ kind: 'text', text: 'ok' }]);
  });

  it('drops an image and decodes the entities', () => {
    expect(parseDescription('<img src=x onerror="alert(1)">a &amp; b &lt;c&gt;')).toEqual([
      { kind: 'text', text: 'a & b <c>' },
    ]);
  });

  it('keeps the text of an unknown tag, without the tag', () => {
    expect(parseDescription('<b>bold</b> and <i>more</i>')).toEqual([
      { kind: 'text', text: 'bold and more' },
    ]);
  });

  it('reads a keyword whose span carries a style', () => {
    expect(
      parseDescription(
        '<span class="inline-attribute-label Healing" style="color: #0F9;">healing</span>',
      ),
    ).toEqual([{ kind: 'keyword', keyword: 'Healing', text: 'healing' }]);
  });

  it('collapses the runs of white space, line breaks of the source included', () => {
    expect(parseDescription('a \n\n  b')).toEqual([{ kind: 'text', text: 'a b' }]);
  });

  it('gives nothing for an empty text', () => {
    expect(parseDescription('')).toEqual([]);
  });
});
