/**
 * The one line a screen shows while its data is loading, or when loading it failed.
 *
 * @packageDocumentation
 */
import { useTranslation } from 'react-i18next';
import { toAppError } from '../../core/errors/app-error';

/** What every kind of line takes: the class of the caller. */
interface StatusLineBaseProps {
  /** Layout and margins only (`mt-4`…): the line owns its colour and size. */
  readonly className?: string;
}

/** Props of {@link StatusLine}: a loading text, the error to explain, or a fixed failure message. */
export type StatusLineProps = StatusLineBaseProps &
  (
    | {
        readonly kind: 'loading';
        /** What is loading, already translated. */
        readonly text: string;
      }
    | {
        readonly kind: 'error';
        /** Whatever the failed query threw: it is explained by its kind, never shown raw. */
        readonly error: unknown;
      }
    | {
        readonly kind: 'alert';
        /**
         * The message of a failure that the screen fixes itself, already translated. It is for a
         * failure whose message does not depend on the error (one that could carry a path of the PC
         * in its text, for instance), never the raw text of an error.
         */
        readonly text: string;
      }
  );

/**
 * A loading text (announced politely as a status), an error (announced at once as an alert), or a
 * fixed failure message (an alert with the look of an error).
 *
 * The error is explained by the translated message of its kind; the technical details stay in the
 * logs. The `alert` kind shows the fixed text of the screen as it is given. The `className` of the
 * caller is for layout and margins (`mt-4`…): the line owns its colour and size.
 *
 * @param props - The kind of line, with its text or its error.
 * @returns The paragraph.
 */
export function StatusLine(props: StatusLineProps) {
  const { t } = useTranslation();

  // The colour and size of the kind first, then what the caller adds (a margin, for instance).
  if (props.kind === 'loading') {
    const classes = ['text-sm text-fg-muted', props.className].filter(Boolean).join(' ');
    return (
      <p role="status" className={classes}>
        {props.text}
      </p>
    );
  }
  const classes = ['text-sm text-loss', props.className].filter(Boolean).join(' ');
  // The same look for both failures: only the text differs, the kind of the error or the fixed one.
  return (
    <p role="alert" className={classes}>
      {props.kind === 'alert' ? props.text : t(`errors.kind.${toAppError(props.error).kind}`)}
    </p>
  );
}
