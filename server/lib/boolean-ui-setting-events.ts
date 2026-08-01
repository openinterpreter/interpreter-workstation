import { EventEmitter } from 'node:events';
import type { BooleanUISettingId } from '../../shared/booleanSettings';

const emitter = new EventEmitter();
const BOOLEAN_UI_SETTING_CHANGED_EVENT = 'boolean-ui-setting-changed';

export interface BooleanUISettingChangedEvent {
  id: BooleanUISettingId;
  enabled: boolean;
}

export function emitBooleanUISettingChanged(event: BooleanUISettingChangedEvent): void {
  emitter.emit(BOOLEAN_UI_SETTING_CHANGED_EVENT, event);
}

export function onBooleanUISettingChanged(
  id: BooleanUISettingId,
  listener: (event: BooleanUISettingChangedEvent) => void,
): () => void {
  const wrappedListener = (event: BooleanUISettingChangedEvent) => {
    if (event.id !== id) {
      return;
    }
    listener(event);
  };

  emitter.on(BOOLEAN_UI_SETTING_CHANGED_EVENT, wrappedListener);
  return () => emitter.off(BOOLEAN_UI_SETTING_CHANGED_EVENT, wrappedListener);
}
