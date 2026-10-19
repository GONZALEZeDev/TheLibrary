/**
 * Tests of the avatar of the linked account: the stored picture, and the generic avatar shown when
 * there is none. Synthetic data only.
 *
 * @packageDocumentation
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_AVATAR_HASH,
  FIXTURE_AVATAR_JPEG,
} from '../../../adapters/dev/fixtures/steam.fixture';
import { bytesToBase64 } from '../../../core/account/linked-account';
import { testAccountId, testLinkedAccount } from '../../../test/test-data';
import { AccountAvatar } from './AccountAvatar';

/** The stored picture, as the database keeps it. */
const AVATAR_BASE64 = bytesToBase64(FIXTURE_AVATAR_JPEG);

/** The account of the fixtures, with its stored picture. */
const WITH_AVATAR = testLinkedAccount(testAccountId(1000001), {
  avatarBase64: AVATAR_BASE64,
  avatarHash: FIXTURE_AVATAR_HASH,
});

/** The same account when no picture is known. */
const WITHOUT_AVATAR = testLinkedAccount(testAccountId(1000001));

/** Each size of the avatar, and the Tailwind class of its box (`size-8` is 32 px, `size-16` 64 px). */
const SIZES = [
  { size: 32, boxClass: 'size-8' },
  { size: 64, boxClass: 'size-16' },
] as const;

describe('AccountAvatar', () => {
  it.each(SIZES)('shows the stored picture in a round $size px box', ({ size, boxClass }) => {
    const { container } = render(<AccountAvatar account={WITH_AVATAR} size={size} />);

    // An empty `alt` makes the picture presentational: it has no `img` role to query by.
    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    expect(image?.getAttribute('src')).toMatch(/^data:image\/jpeg;base64,/);
    expect(image).toHaveAttribute('src', `data:image/jpeg;base64,${AVATAR_BASE64}`);
    expect(image).toHaveAttribute('alt', '');
    expect(image).toHaveAttribute('width', String(size));
    expect(image).toHaveAttribute('height', String(size));
    expect(image).toHaveClass('rounded-full', 'object-cover', boxClass);
  });

  it.each([
    { name: 'no account is linked', account: null },
    { name: 'the account has no picture', account: WITHOUT_AVATAR },
  ])('shows the generic avatar when $name', ({ account }) => {
    const { container } = render(<AccountAvatar account={account} size={32} />);

    const placeholder = container.firstElementChild;
    expect(placeholder).toHaveAttribute('aria-hidden', 'true');
    expect(placeholder).toHaveClass('rounded-full', 'bg-surface-raised');
    // The generic person is an icon: no picture, and nothing for assistive technologies to read.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it.each(SIZES)(
    'gives the generic avatar the box of the $size px picture',
    ({ size, boxClass }) => {
      const { container } = render(<AccountAvatar account={null} size={size} />);

      // The same box as the picture's, so the layout does not move when an account gains a picture.
      expect(container.firstElementChild).toHaveClass(boxClass);
    },
  );
});
