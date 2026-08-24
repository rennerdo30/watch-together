'use client';

import { useCallback, useSyncExternalStore } from 'react';

const LOCAL_STORAGE_CHANGE = 'w2g-local-storage-change';

type Parser<T> = (stored: string | null, fallback: T) => T;
type Serializer<T> = (value: T) => string;

/**
 * Hydration-safe React state backed by localStorage.
 *
 * A lazy `useState` initializer reads the persisted value before hydration and
 * disagrees with the server-rendered default. Reading it in an effect avoids
 * that mismatch but creates a second render, and any mount effect that copied
 * the initial state into an external system (the `<video>` element) captures
 * the default forever. `useSyncExternalStore` is designed for exactly this:
 * hydration sees the server snapshot, then React reads the client snapshot and
 * updates every subscriber without an effect calling setState.
 */
export function useLocalStorageState<T>(
  key: string,
  fallback: T,
  parse: Parser<T>,
  serialize: Serializer<T> = String,
): readonly [T, (value: T) => void] {
  const subscribe = useCallback((notify: () => void) => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) notify();
    };
    const onLocalChange = (event: Event) => {
      if ((event as CustomEvent<{ key: string }>).detail?.key === key) notify();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener(LOCAL_STORAGE_CHANGE, onLocalChange);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(LOCAL_STORAGE_CHANGE, onLocalChange);
    };
  }, [key]);

  const getSnapshot = useCallback(
    () => parse(localStorage.getItem(key), fallback),
    [key, fallback, parse],
  );
  const getServerSnapshot = useCallback(() => fallback, [fallback]);
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setValue = useCallback((next: T) => {
    localStorage.setItem(key, serialize(next));
    window.dispatchEvent(new CustomEvent(LOCAL_STORAGE_CHANGE, {
      detail: { key },
    }));
  }, [key, serialize]);

  return [value, setValue] as const;
}
