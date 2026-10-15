// How a council (a profile) is named in the interface: the two automatic ones by the interface's own words, the rest by the
// name the user gave.

import type { I18n } from '@/i18n/index.tsx';
import type { ProfileView } from '../../../src/shared/types.ts';

export const profileName = (
  profile: Pick<ProfileView, 'id' | 'auto' | 'name'>,
  t: I18n['t'],
): string =>
  profile.auto ? t(profile.id === 'quick' ? 'profile.quick' : 'profile.default') : profile.name;
