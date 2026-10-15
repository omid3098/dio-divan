// A working folder is shown by its last segment (the full path in a tooltip), and a session from a client of the endpoint is
// marked by the client's name.

import { describe, expect, it } from 'vitest';

const MODULE = '../web/src/lib/folder.ts';

describe('the folder chip and the origin marker', async () => {
  const { folderName, clientName } = (await import(MODULE)) as {
    folderName(path: string): string;
    clientName(client: string | undefined): string | null;
  };

  it('a folder is its last path segment, on Windows and elsewhere, with or without a trailing separator', () => {
    expect(folderName('E:\\w\\dio-divan')).toBe('dio-divan');
    expect(folderName('E:\\w\\dio-divan\\')).toBe('dio-divan');
    expect(folderName('/home/omid/projects/app/')).toBe('app');
    expect(folderName('/home/omid/پروژه')).toBe('پروژه');
    expect(folderName('C:\\')).toBe('C:');
    expect(folderName('/')).toBe('/');
  });

  it('Pi and T3 Code are named, any other client keeps its own name, none gives none', () => {
    expect(clientName('pi')).toBe('Pi');
    expect(clientName('pi-coding-agent')).toBe('Pi');
    expect(clientName('PI')).toBe('Pi');
    expect(clientName('t3-code')).toBe('T3 Code');
    expect(clientName('T3Code')).toBe('T3 Code');
    expect(clientName('curl')).toBe('curl');
    expect(clientName('pigeon')).toBe('pigeon');
    expect(clientName(undefined)).toBeNull();
    expect(clientName('  ')).toBeNull();
  });
});
