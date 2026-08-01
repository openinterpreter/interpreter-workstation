/**
 * Hook that sends desktop notifications whenever a programmatic agent task starts.
 *
 * Uses Electron Notification (via IPC) when in Electron, falls back to
 * Web Notifications API in browser/dev mode.
 */

import { useEffect } from 'react';
import { desktopNotification, programmaticTasks } from '@/ipc';
import type { ProgrammaticTaskStartedEvent } from '../../electron/ipc/registry';

const isElectron = !!window.electron;

function showWebNotification(title: string, body: string) {
  if (!('Notification' in window)) return;

  const send = () => {
    const notification = new Notification(title, { body });
    notification.onclick = () => {
      window.focus();
    };
  };

  if (Notification.permission === 'granted') {
    send();
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then((permission) => {
      if (permission === 'granted') {
        send();
      }
    }).catch(() => {});
  }
}

function buildNotification(event: ProgrammaticTaskStartedEvent): { title: string; body: string } {
  const title = event.mode === 'headed'
    ? 'Programmatic agent task started'
    : 'Programmatic headless task started';

  return {
    title,
    body: event.messagePreview || 'Programmatic agent task started',
  };
}

export function useProgrammaticTaskNotifications() {
  useEffect(() => {
    const unsubscribe = programmaticTasks.onStarted((event: ProgrammaticTaskStartedEvent) => {
      const { title, body } = buildNotification(event);

      if (isElectron) {
        desktopNotification.show({ title, body }).catch(() => {});
        return;
      }

      showWebNotification(title, body);
    });

    return unsubscribe;
  }, []);
}
