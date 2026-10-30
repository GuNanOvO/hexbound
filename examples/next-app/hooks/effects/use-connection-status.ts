'use client';

import { useEffect, useReducer } from 'react';

export type ConnectionStatus = 'online' | 'offline';

type ConnectionAction =
  | Readonly<{ type: 'connection-online' }>
  | Readonly<{ type: 'connection-offline' }>;

function assertNever(value: never): never {
  throw new Error(`Unhandled connection action: ${String(value)}`);
}

function connectionReducer(_state: ConnectionStatus, action: ConnectionAction): ConnectionStatus {
  switch (action.type) {
    case 'connection-online':
      return 'online';
    case 'connection-offline':
      return 'offline';
    default:
      return assertNever(action);
  }
}

/**
 * Subscribes to the browser's real online/offline event source.
 * The initial value is resolved inside the Effect so the server render is stable.
 */
export function useConnectionStatus(): ConnectionStatus {
  const [status, dispatch] = useReducer(connectionReducer, 'online');

  /**
   * @effect-external: browser Window online/offline events and navigator.onLine
   * @effect-setup: subscribe to both events and synchronize the initial browser connection status
   * @effect-cleanup: remove both listeners when the subscribing component unmounts
   */
  useEffect(() => {
    const handleOnline = (): void => {
      dispatch({ type: 'connection-online' });
    };
    const handleOffline = (): void => {
      dispatch({ type: 'connection-offline' });
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    dispatch(navigator.onLine ? { type: 'connection-online' } : { type: 'connection-offline' });
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [dispatch]);

  return status;
}
