/**
 * Tests of the small pieces every screen is made of: the button, the panel, the status line (a
 * loading text or an error) and the segmented control.
 *
 * @packageDocumentation
 */
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { RefreshCw } from 'lucide-react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../core/errors/app-error';
import { createI18n } from '../i18n/i18n';
import { Button } from './Button';
import { BUTTON_CLASSES, BUTTON_WITH_ICON_CLASS, type ButtonLook } from './button-styles';
import { Panel, PANEL_CLASSES } from './Panel';
import { SegmentedControl } from './SegmentedControl';
import { StatusLine } from './StatusLine';

describe('Button', () => {
  it.each(Object.keys(BUTTON_CLASSES) as ButtonLook[])(
    'renders each look of the button and spins its icon (%s)',
    (look) => {
      const { container, rerender } = render(
        <Button look={look} icon={RefreshCw}>
          Retry
        </Button>,
      );

      const button = screen.getByRole('button', { name: 'Retry' });
      // A button never submits a form by accident.
      expect(button).toHaveAttribute('type', 'button');
      // The look is the class list of its name, nothing more or less.
      for (const className of BUTTON_CLASSES[look].split(' ')) {
        expect(button).toHaveClass(className);
      }
      // The icon is a picture next to the text: it says nothing to assistive technologies, and it
      // stands still until the button says it is working.
      const icon = container.querySelector('svg');
      expect(icon).toHaveAttribute('aria-hidden', 'true');
      expect(icon).not.toHaveClass('motion-safe:animate-spin');

      rerender(
        <Button look={look} icon={RefreshCw} spinning>
          Retry
        </Button>,
      );

      // Same icon, now turning (and only for people who did not ask for less motion).
      expect(container.querySelector('svg')).toHaveClass('motion-safe:animate-spin');
    },
  );

  it('keeps the native attributes and the click of a button, and lets a button submit when asked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <>
        <Button look="subtle" onClick={onClick} className="mt-4">
          Save
        </Button>
        <Button look="primary" type="submit" disabled>
          Send
        </Button>
      </>,
    );

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveClass('mt-4');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('type', 'submit');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('draws a button without an icon exactly as its look, with no icon slot', () => {
    const { container } = render(<Button look="primary">Go</Button>);

    expect(container.querySelector('svg')).toBeNull();
    // Exactly the classes of the look: the row layout of the icon slot is not there.
    expect(screen.getByRole('button', { name: 'Go' }).className).toBe(BUTTON_CLASSES.primary);
  });

  it('lays a button with an icon out as a row after the classes of its look', () => {
    render(
      <Button look="subtle" icon={RefreshCw}>
        Retry
      </Button>,
    );

    expect(screen.getByRole('button', { name: 'Retry' }).className).toBe(
      `${BUTTON_CLASSES.subtle} ${BUTTON_WITH_ICON_CLASS}`,
    );
  });

  it('hands its button element to the ref of its caller, to focus it', () => {
    const ref = vi.fn();
    render(
      <Button look="primary" ref={ref}>
        Go
      </Button>,
    );

    expect(ref).toHaveBeenCalledWith(screen.getByRole('button', { name: 'Go' }));
  });
});

describe('Panel', () => {
  it('renders a panel as a section with its padding', () => {
    render(
      <Panel padding="normal" aria-labelledby="panel-title">
        <h2 id="panel-title">Title</h2>
      </Panel>,
    );

    // A section with a name is a landmark, so the panel is found by its role and its label.
    const panel = screen.getByRole('region', { name: 'Title' });
    expect(panel.tagName).toBe('SECTION');
    expect(panel).toHaveClass('rounded-xl', 'border', 'border-border', 'bg-surface', 'p-4');
  });

  it.each([
    ['tight', 'p-1'],
    ['normal', 'p-4'],
    ['roomy', 'p-6'],
  ] as const)('pads a %s panel with %s', (padding, expected) => {
    const { container } = render(<Panel padding={padding}>Content</Panel>);

    expect(container.firstElementChild).toHaveClass(expected);
    expect(PANEL_CLASSES.padding[padding]).toBe(expected);
  });

  it('renders a div when asked, and keeps the class of its user after its own', () => {
    const { container } = render(
      <Panel as="div" padding="tight" className="mt-6" data-testid="tile">
        Content
      </Panel>,
    );

    const panel = container.firstElementChild;
    expect(panel?.tagName).toBe('DIV');
    expect(panel).toHaveAttribute('data-testid', 'tile');
    expect(panel).toHaveClass('mt-6');
    // The base class string is the one the class-only users share.
    for (const className of PANEL_CLASSES.base.split(' ')) {
      expect(panel).toHaveClass(className);
    }
  });

  it('hands its element to the ref of its caller, as a section and as a div', () => {
    const sectionRef = vi.fn();
    const divRef = vi.fn();
    const { container } = render(
      <>
        <Panel padding="normal" ref={sectionRef}>
          Section
        </Panel>
        <Panel as="div" padding="normal" ref={divRef}>
          Div
        </Panel>
      </>,
    );

    expect(sectionRef).toHaveBeenCalledWith(container.querySelector('section'));
    expect(divRef).toHaveBeenCalledWith(container.querySelector('div'));
  });
});

describe('StatusLine', () => {
  it.each([
    ['en', 'Loading your matches...'],
    ['fr', 'Chargement de tes parties...'],
  ] as const)('says loading as a status in %s', async (language, text) => {
    const i18n = await createI18n(language);
    render(
      <I18nextProvider i18n={i18n}>
        <StatusLine kind="loading" text={text} />
      </I18nextProvider>,
    );

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(text);
    expect(status).toHaveClass('text-sm', 'text-fg-muted');
  });

  it('adds the class of its caller to its own classes, for the layout and the margins', async () => {
    const i18n = await createI18n('en');
    render(
      <I18nextProvider i18n={i18n}>
        <StatusLine kind="loading" text="Loading..." className="mt-4" />
        <StatusLine kind="error" error="boom" className="mt-4" />
      </I18nextProvider>,
    );

    // The line keeps its own colour and size, and gains the margin of the caller.
    expect(screen.getByRole('status')).toHaveClass('text-sm', 'text-fg-muted', 'mt-4');
    expect(screen.getByRole('alert')).toHaveClass('text-sm', 'text-loss', 'mt-4');
  });

  it.each([
    ['en', 'The server could not be reached. Check your internet connection.'],
    ['fr', 'Impossible de joindre le serveur. Vérifie ta connexion internet.'],
  ] as const)('says an error as an alert with its kind in %s', async (language, text) => {
    const i18n = await createI18n(language);
    render(
      <I18nextProvider i18n={i18n}>
        <StatusLine kind="error" error={new AppError('network', 'GET /v1/info failed')} />
      </I18nextProvider>,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(text);
    expect(alert).toHaveClass('text-sm', 'text-loss');
    // The technical message of the error is for the logs: it is never shown.
    expect(alert).not.toHaveTextContent('GET /v1/info failed');
  });

  it('says a fixed message as an alert with the look of an error, and adds the class of its caller', async () => {
    const i18n = await createI18n('en');
    render(
      <I18nextProvider i18n={i18n}>
        <StatusLine kind="alert" text="The folder could not be opened." className="mt-3" />
      </I18nextProvider>,
    );

    // The text is shown as given (it is already translated), never replaced by an error kind.
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The folder could not be opened.');
    expect(alert).toHaveClass('text-sm', 'text-loss', 'mt-3');
  });

  it.each([
    ['en', 'An unexpected error occurred.'],
    ['fr', 'Une erreur inattendue est survenue.'],
  ] as const)(
    'says anything that is not an app error as an unexpected one in %s',
    async (language, text) => {
      const i18n = await createI18n(language);
      render(
        <I18nextProvider i18n={i18n}>
          <StatusLine kind="error" error="boom" />
        </I18nextProvider>,
      );

      expect(screen.getByRole('alert')).toHaveTextContent(text);
      // What was thrown is for the logs: it is never shown.
      expect(screen.getByRole('alert')).not.toHaveTextContent('boom');
    },
  );
});

describe('SegmentedControl', () => {
  it('checks the chosen option and calls back with the value of the one picked', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn<(value: 'all' | 'win' | 'loss') => void>();
    render(
      <SegmentedControl
        legend="Result"
        segments={[
          { value: 'all', label: 'All' },
          { value: 'win', label: 'Wins' },
          { value: 'loss', label: 'Losses' },
        ]}
        value="win"
        onPick={onPick}
      />,
    );

    // A native radio group, named by its legend.
    const group = screen.getByRole('group', { name: 'Result' });
    expect(group).toContainElement(screen.getByRole('radio', { name: 'Wins' }));
    expect(screen.getByRole('radio', { name: 'Wins' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'All' })).not.toBeChecked();

    await user.click(screen.getByRole('radio', { name: 'Losses' }));

    expect(onPick).toHaveBeenCalledWith('loss');
  });

  it('checks no option when the value is none of them', () => {
    render(
      <SegmentedControl
        legend="Hero"
        segments={[
          { value: 67, label: 'Paige' },
          { value: 'all', label: 'All heroes' },
        ]}
        value={12}
        onPick={vi.fn()}
      />,
    );

    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).not.toBeChecked();
    }
  });
});
