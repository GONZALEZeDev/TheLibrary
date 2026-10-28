/**
 * Tests of the notices generator: which crates are shipped, and how the notices are written.
 */
import { describe, expect, it } from 'vitest';
import {
  normalRustDependencies,
  renderNotices,
  type CargoMetadata,
  type NoticeEntry,
} from './third-party-notices.ts';

/** A package of the metadata fixture: only the fields the generator reads. */
function cratePackage(id: string): CargoMetadata['packages'][number] {
  return { id, name: id, version: '1.0.0', license: 'MIT', manifest_path: `/${id}/Cargo.toml` };
}

const METADATA: CargoMetadata = {
  packages: ['app', 'tauri', 'serde', 'cc', 'tempfile', 'shared'].map(cratePackage),
  resolve: {
    root: 'app',
    nodes: [
      {
        id: 'app',
        deps: [
          { pkg: 'tauri', dep_kinds: [{ kind: null }] },
          { pkg: 'cc', dep_kinds: [{ kind: 'build' }] },
          { pkg: 'tempfile', dep_kinds: [{ kind: 'dev' }] },
        ],
      },
      {
        id: 'tauri',
        deps: [
          { pkg: 'serde', dep_kinds: [{ kind: null }] },
          // Both a build and a normal dependency: it is shipped.
          { pkg: 'shared', dep_kinds: [{ kind: 'build' }, { kind: null }] },
        ],
      },
      { id: 'cc', deps: [{ pkg: 'shared', dep_kinds: [{ kind: null }] }] },
      { id: 'serde', deps: [] },
      { id: 'tempfile', deps: [] },
      { id: 'shared', deps: [] },
    ],
  },
};

const APACHE = (wrap: string) =>
  `Apache License${wrap}Version 2.0, January 2004\nhttp://www.apache.org/licenses/\n\nTERMS…\n\nEND OF TERMS AND CONDITIONS\n`;

describe('normalRustDependencies', () => {
  it('follows normal dependencies only, and leaves the root out', () => {
    expect(normalRustDependencies(METADATA)).toEqual(new Set(['tauri', 'serde', 'shared']));
  });

  it('gives nothing without a root', () => {
    expect(
      normalRustDependencies({ ...METADATA, resolve: { ...METADATA.resolve, root: null } }),
    ).toEqual(new Set());
  });
});

describe('renderNotices', () => {
  const npm: NoticeEntry[] = [
    { name: 'zod', version: '4.6.7', license: 'MIT', texts: ['MIT\nCopyright Colin\n'] },
    { name: 'react', version: '19.3.1', license: 'MIT', texts: ['MIT\nCopyright Meta\n'] },
  ];
  const rust: NoticeEntry[] = [
    {
      name: 'tauri',
      version: '2.12.5',
      license: 'Apache-2.0 OR MIT',
      texts: [APACHE('\n'), 'MIT\r\nCopyright Tauri\r\n'],
    },
    { name: 'serde', version: '1.0.0', license: 'MIT OR Apache-2.0', texts: [APACHE('\n   ')] },
    { name: 'crc', version: '2.5.0', license: 'MIT', texts: [] },
  ];
  const output = renderNotices(npm, rust);

  it('lists each ecosystem sorted by name', () => {
    expect(output.indexOf('- react 19.3.1')).toBeLessThan(output.indexOf('- zod 4.6.7'));
    expect(output.indexOf('## Rust crates')).toBeLessThan(output.indexOf('- crc 2.5.0'));
    expect(output.indexOf('- crc 2.5.0')).toBeLessThan(output.indexOf('- serde 1.0.0'));
  });

  it('prints the Apache licence once whatever its wrapping', () => {
    expect(output.match(/END OF TERMS AND CONDITIONS/g)).toHaveLength(1);
    const tauriLine = output.split('\n').find((line) => line.startsWith('- tauri '));
    const serdeLine = output.split('\n').find((line) => line.startsWith('- serde '));
    const apacheRef = /\[text (\d+)\]/.exec(serdeLine ?? '')?.[1];
    expect(tauriLine).toContain(`[text ${apacheRef ?? '?'}]`);
  });

  it('keeps the texts that differ, with their own copyright lines', () => {
    expect(output).toContain('Copyright Colin');
    expect(output).toContain('Copyright Meta');
    expect(output).toContain('Copyright Tauri');
    expect(output).not.toContain('\r');
  });

  it('says when a package ships no licence text', () => {
    expect(output).toContain('- crc 2.5.0 — MIT — licence text not shipped by the package');
  });

  it('gives every reference a matching anchor', () => {
    const refs = new Set([...output.matchAll(/\(#(text-\d+)\)/g)].map((match) => match[1]));
    for (const ref of refs) {
      expect(output).toContain(`<a id="${ref ?? ''}"></a>`);
    }
    expect(refs.size).toBe(4);
  });
});
