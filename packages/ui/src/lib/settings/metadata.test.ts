import { describe, expect, test } from 'bun:test';

import { SETTINGS_PAGE_METADATA } from './metadata';

import { settingsDict as deDict } from '@/lib/i18n/messages/de.settings';
import { settingsDict as enDict } from '@/lib/i18n/messages/en.settings';
import { settingsDict as esDict } from '@/lib/i18n/messages/es.settings';
import { settingsDict as frDict } from '@/lib/i18n/messages/fr.settings';
import { settingsDict as jaDict } from '@/lib/i18n/messages/ja.settings';
import { settingsDict as koDict } from '@/lib/i18n/messages/ko.settings';
import { settingsDict as plDict } from '@/lib/i18n/messages/pl.settings';
import { settingsDict as ptBrDict } from '@/lib/i18n/messages/pt-BR.settings';
import { settingsDict as ukDict } from '@/lib/i18n/messages/uk.settings';
import { settingsDict as zhCnDict } from '@/lib/i18n/messages/zh-CN.settings';
import { settingsDict as zhTwDict } from '@/lib/i18n/messages/zh-TW.settings';

const settingsDictionaries = {
  en: enDict,
  de: deDict,
  es: esDict,
  fr: frDict,
  ja: jaDict,
  ko: koDict,
  pl: plDict,
  'pt-BR': ptBrDict,
  uk: ukDict,
  'zh-CN': zhCnDict,
  'zh-TW': zhTwDict,
} as const;

describe('settings metadata', () => {
  test('the servers page keeps the renamed title and server keywords', () => {
    const meta = SETTINGS_PAGE_METADATA.find((entry) => entry.slug === 'remote-instances');
    expect(meta).toBeDefined();
    expect(meta?.title).toBe('Servers');
    const keywords = meta?.keywords ?? [];
    expect(keywords.join(' ')).toContain('server');
  });

  test('every locale translates the servers page title', () => {
    for (const [locale, dictionary] of Object.entries(settingsDictionaries)) {
      const pageTitle = dictionary['settings.page.remoteInstances.title'];
      const sidebarTitle = dictionary['settings.remoteInstances.sidebar.title'];
      expect(pageTitle).toBeTruthy();
      expect(pageTitle).not.toBe('Remote Instances');
      expect(sidebarTitle).toBeTruthy();
      expect(sidebarTitle).not.toBe('Remote Instances');
      expect(`${locale} has a servers page title`).toBeTruthy();
    }
  });
});
