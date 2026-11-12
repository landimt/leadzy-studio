import type { EffectBlock } from '../../../core/schema.js';
import { UI_ICON } from '../../components/UiIcon.js';

const FLASH_ICON_PATH = 'M8.7 1.3 2 9.3h6l-.7 5.4L14 6.7H8l.7-5.4z';
const SHAKE_ICON_PATH =
  'M5 5h6v6H5z M2.5 2.5l1.5 1.5 M2.5 13.5l1.5-1.5 M13.5 2.5l-1.5 1.5 M13.5 13.5l-1.5-1.5';

/** Effect type → icon path, shared by the effects panel and the inspector heading. */
export const EFFECT_ICON: Record<EffectBlock['type'], string> = {
  zoom: UI_ICON.zoom,
  flash: FLASH_ICON_PATH,
  shake: SHAKE_ICON_PATH,
};
