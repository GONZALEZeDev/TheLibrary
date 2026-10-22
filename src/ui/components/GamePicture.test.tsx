/**
 * Tests of the picture of the game: the decorative image with its box known before the file arrives,
 * the neutral square or the nothing that stands in place of a picture the catalogue does not give,
 * and the same stand-in for a picture that fails to load (the app works offline, and the pictures
 * live on a remote bucket).
 *
 * @packageDocumentation
 */
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GamePicture } from './GamePicture';

/** Where the pictures of the catalogues live. */
const IMAGE_ORIGIN = 'https://assets-bucket.deadlock-api.com/';

/** A picture of the tests. */
const HERO_PICTURE = `${IMAGE_ORIGIN}heroes/hero.webp`;

/** Another address for the same picture, as a refreshed catalogue gives. */
const OTHER_PICTURE = `${IMAGE_ORIGIN}heroes/hero-v2.webp`;

/**
 * Find the picture a render shows.
 *
 * @param container - The root of the render.
 * @returns The `img` element.
 */
function pictureIn(container: HTMLElement): HTMLImageElement {
  return container.querySelector('img') ?? expect.unreachable('No picture is shown');
}

describe('GamePicture', () => {
  it('shows a decorative picture whose box is known before the file arrives', () => {
    const { container } = render(
      <GamePicture src={HERO_PICTURE} size="small" fit="cover" fallback="none" />,
    );

    const picture = container.querySelector('img');
    expect(picture).toHaveAttribute('src', HERO_PICTURE);
    // Decorative: the name is always written beside it.
    expect(picture).toHaveAttribute('alt', '');
    expect(picture).toHaveAttribute('width', '24');
    expect(picture).toHaveAttribute('height', '24');
    expect(picture).toHaveClass('size-6', 'object-cover');
  });

  it('gives the medium picture 32 pixels and the fit it is told', () => {
    const { container } = render(
      <GamePicture src={HERO_PICTURE} size="medium" fit="contain" fallback="square" />,
    );

    const picture = container.querySelector('img');
    expect(picture).toHaveAttribute('width', '32');
    expect(picture).toHaveAttribute('height', '32');
    expect(picture).toHaveClass('size-8', 'object-contain');
    expect(picture).not.toHaveClass('object-cover');
  });

  it('shows a neutral square of the same size for a missing picture when told to', () => {
    const { container } = render(
      <GamePicture src={null} size="medium" fit="contain" fallback="square" />,
    );

    expect(container.querySelector('img')).toBeNull();
    const square = container.firstElementChild;
    expect(square).toHaveAttribute('aria-hidden', 'true');
    expect(square).toHaveClass('size-8');
  });

  it('shows nothing for a missing picture when the name stands alone', () => {
    const { container } = render(
      <GamePicture src={null} size="small" fit="cover" fallback="none" />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('replaces a picture that fails to load with the neutral square', () => {
    const { container } = render(
      <GamePicture src={HERO_PICTURE} size="small" fit="contain" fallback="square" />,
    );

    // The browser's broken-image icon would otherwise stay in its place.
    fireEvent.error(pictureIn(container));

    expect(container.querySelector('img')).toBeNull();
    const square = container.firstElementChild;
    expect(square).toHaveAttribute('aria-hidden', 'true');
    expect(square).toHaveClass('size-6');
  });

  it('removes a picture that fails to load when the name stands alone', () => {
    const { container } = render(
      <GamePicture src={HERO_PICTURE} size="small" fit="cover" fallback="none" />,
    );

    fireEvent.error(pictureIn(container));

    expect(container).toBeEmptyDOMElement();
  });

  it('tries a new address again after one failed', () => {
    const { container, rerender } = render(
      <GamePicture src={HERO_PICTURE} size="small" fit="cover" fallback="none" />,
    );
    fireEvent.error(pictureIn(container));
    expect(container).toBeEmptyDOMElement();

    // The same address stays failed: the picture is not asked for again at every render.
    rerender(<GamePicture src={HERO_PICTURE} size="small" fit="cover" fallback="none" />);
    expect(container).toBeEmptyDOMElement();

    // A refreshed catalogue gives another address, which is worth a try.
    rerender(<GamePicture src={OTHER_PICTURE} size="small" fit="cover" fallback="none" />);
    expect(container.querySelector('img')).toHaveAttribute('src', OTHER_PICTURE);
  });
});
