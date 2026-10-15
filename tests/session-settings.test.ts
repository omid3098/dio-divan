import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { compileCouncil, finalAgent } from '../src/shared/flow.ts';
import { note } from '../src/shared/messages.ts';
import { SessionSettings } from '../web/src/components/session-settings.tsx';
import { I18nProvider } from '../web/src/i18n/index.tsx';
import { noteText, useNotes } from '../web/src/i18n/notes.tsx';
import { singleFlow } from './fixtures/flows.ts';
import { sessionOf, userNode } from './fixtures.ts';

// Read the settings content without a portal or browser.
vi.mock('@/components/ui/dialog', () => {
  const wrapper = ({ children }: { children: ReactNode }) => createElement('div', null, children);
  return Object.fromEntries(
    [
      'Dialog',
      'DialogContent',
      'DialogDescription',
      'DialogFooter',
      'DialogHeader',
      'DialogTitle',
    ].map((name) => [name, wrapper]),
  );
});

it('uses the frozen final agent’s access for councils and designs, and only known access for old sessions', () => {
  const session = sessionOf([userNode('u0', null, 'Q')]);
  const render = () =>
    renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(SessionSettings, { session, open: true, onOpenChange: () => {} }),
      ),
    );
  for (const [lang, on, off, web] of [
    ['en', 'On', 'Off', 'Web off.'],
    ['fa', 'روشن', 'خاموش', 'وب خاموش است.'],
  ]) {
    vi.stubGlobal('localStorage', { getItem: () => lang });
    try {
      for (const flow of [compileCouncil(session.settings), singleFlow()]) {
        session.settings.flow = flow;
        const final = finalAgent(flow);
        final.tools = true;
        final.memory = false;
        session.settings.chairman.memory = true;
        expect(render()).toContain(
          lang === 'en'
            ? `read-only tools ${on}; memory ${off}; web off.`
            : `ابزارهای خواندن ${on}؛ حافظه ${off}؛ وب خاموش است.`,
        );
        final.tools = false;
        final.memory = true;
        expect(render()).toContain(
          lang === 'en'
            ? `read-only tools ${off}; memory ${on}; web off.`
            : `ابزارهای خواندن ${off}؛ حافظه ${on}؛ وب خاموش است.`,
        );
      }
      delete session.settings.flow;
      delete session.settings.chairman.memory;
      expect(render()).toContain(web);
      expect(render()).not.toContain(lang === 'en' ? 'read-only tools' : 'ابزارهای خواندن');
      session.settings.chairman.memory = true;
      expect(render()).toContain(
        lang === 'en'
          ? 'Read-only memory on; web off.'
          : 'حافظه برای خواندن روشن است؛ وب خاموش است.',
      );
      session.settings.chairman.tools = false;
      expect(render()).toContain(
        lang === 'en'
          ? `read-only tools ${off}; memory ${on}; web off.`
          : `ابزارهای خواندن ${off}؛ حافظه ${on}؛ وب خاموش است.`,
      );
      delete session.settings.chairman.tools;
    } finally {
      vi.unstubAllGlobals();
    }
  }
});

it('words an invalidated model’s level as the interface does, in text and rendered notes', () => {
  const coded = note('library_invalidates_model', {
    model: 'check',
    level: 'high',
    reason: 'fields',
  });
  expect(coded.message).toContain('at High');
  for (const [lang, level] of [
    ['en', 'High'],
    ['fa', 'زیاد'],
  ]) {
    vi.stubGlobal('localStorage', { getItem: () => lang });
    const Sentence = () => {
      const notes = useNotes();
      expect(noteText(coded)).toContain(level);
      expect(noteText(coded)).not.toContain('high');
      return notes.node(coded);
    };
    try {
      expect(
        renderToStaticMarkup(createElement(I18nProvider, null, createElement(Sentence))),
      ).toContain(level);
    } finally {
      vi.unstubAllGlobals();
    }
  }
});

it('keeps the agy warning and uncontrolled tools, memory and web in frozen single and council settings', () => {
  const session = sessionOf([userNode('u0', null, 'Q')]);
  for (const lang of ['en', 'fa']) {
    vi.stubGlobal('localStorage', { getItem: () => lang });
    try {
      for (const flow of [compileCouncil(session.settings), singleFlow()]) {
        session.settings.flow = flow;
        const final = finalAgent(flow);
        final.harness = 'agy';
        final.tools = final.memory = final.web = false;
        const rendered = renderToStaticMarkup(
          createElement(
            I18nProvider,
            null,
            createElement(SessionSettings, { session, open: true, onOpenChange: () => {} }),
          ),
        );
        expect(rendered).toContain('data-testid="agy-warning"');
        expect(rendered).toContain(
          lang === 'en' ? 'Divan cannot stop it.' : 'Divan نمی‌تواند جلوی آن را بگیرد.',
        );
        expect(rendered).toContain(
          lang === 'en' ? 'own settings control tools, memory and web' : 'تنظیمات خود agy',
        );
        expect(rendered).not.toContain(lang === 'en' ? 'web off.' : 'وب خاموش است.');
      }
    } finally {
      vi.unstubAllGlobals();
    }
  }
});
