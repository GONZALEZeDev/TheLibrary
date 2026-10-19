/**
 * The round avatar of the linked Steam account, or a generic one when there is none.
 *
 * @packageDocumentation
 */
import { UserRound } from 'lucide-react';
import { avatarDataUri, type LinkedAccount } from '../../../core/account/linked-account';

/** Props of {@link AccountAvatar}. */
export interface AccountAvatarProps {
  /** The linked account, or `null` when none is linked (the generic avatar is shown). */
  readonly account: LinkedAccount | null;
  /** Width and height in pixels: 32 for the sidebar, 64 for the Settings card. */
  readonly size: 32 | 64;
}

/**
 * The Tailwind classes of each size, written in full: Tailwind finds the classes in the source as
 * complete strings, and a class built from the size (`size-${…}`) would never be generated. This is
 * the one place that sizes the avatar: the picture and the generic avatar share the same `box`, so
 * the layout around them does not move when an account gains or loses its picture.
 */
const SIZE_CLASSES: Readonly<Record<AccountAvatarProps['size'], { box: string; icon: string }>> = {
  32: { box: 'size-8', icon: 'size-4' },
  64: { box: 'size-16', icon: 'size-8' },
};

/**
 * The avatar of the linked account: its stored picture, round. An account with no avatar (Steam or
 * deadlock-api gave none), or no account at all, gets a generic person in a round box of the same
 * size.
 *
 * The picture is decorative (empty `alt`): the persona name is always written next to it.
 *
 * @returns The picture, or the generic avatar.
 */
export function AccountAvatar({ account, size }: AccountAvatarProps) {
  const avatar = account?.avatarBase64 ?? null;
  const { box, icon } = SIZE_CLASSES[size];
  if (avatar !== null) {
    // `width` and `height` give the browser the size before the picture is decoded; the box classes
    // set it (Tailwind's base styles make images `height: auto`), and `object-cover` keeps a picture
    // that is not square from being stretched.
    return (
      <img
        src={avatarDataUri(avatar)}
        alt=""
        width={size}
        height={size}
        className={`shrink-0 rounded-full object-cover ${box}`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full bg-surface-raised text-fg-muted ${box}`}
    >
      <UserRound className={icon} />
    </span>
  );
}
