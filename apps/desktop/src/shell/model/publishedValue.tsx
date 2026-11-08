/**
 * A value handed down a page the way a context is, without what a context
 * costs when it changes often over a large tree.
 *
 * When a context's value changes, React looks through everything under the
 * provider for whoever reads it — every fiber of a long transcript, on every
 * app snapshot and every frame of a streaming conversation, which was a large
 * part of the Conversations page's frames (docs/process-model.md, phase 6c).
 * Here the context holds a store that is the same object for the provider's
 * life. The provider puts each new value in it as it draws, so what draws in
 * the same pass reads that value; once it is committed the store tells its
 * readers, and React draws again only those whose reading of it changed.
 */

import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type Context,
  type ReactNode,
} from "react";

export class ValueStore<T> {
  #value: T;
  readonly #listeners = new Set<() => void>();

  constructor(value: T) {
    this.#value = value;
  }

  readonly get = (): T => this.#value;

  /** The value being drawn: read by what draws after it in the same pass. */
  set(value: T): void {
    this.#value = value;
  }

  /** The value is committed: every reader compares what it reads. */
  publish(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
}

/** The store for `value`, kept for the caller's life and published on each commit. */
export function usePublishedStore<T>(value: T): ValueStore<T> {
  const [store] = useState(() => new ValueStore(value));
  store.set(value);
  useLayoutEffect(() => store.publish(), [store, value]);
  return store;
}

const NO_SUBSCRIPTION = () => () => undefined;

export interface PublishedContext<T> {
  readonly Context: Context<ValueStore<T> | undefined>;
  readonly Provider: (props: {
    readonly value: T;
    readonly children: ReactNode;
  }) => ReactNode;
  /** The value, or `undefined` outside a provider. */
  readonly useValue: () => T | undefined;
}

export function createPublishedContext<T>(): PublishedContext<T> {
  const Context = createContext<ValueStore<T> | undefined>(undefined);
  const none = () => undefined;
  function Provider({
    value,
    children,
  }: {
    readonly value: T;
    readonly children: ReactNode;
  }) {
    const store = usePublishedStore(value);
    return <Context.Provider value={store}>{children}</Context.Provider>;
  }
  function useValue(): T | undefined {
    const store = useContext(Context);
    return useSyncExternalStore(
      store?.subscribe ?? NO_SUBSCRIPTION,
      store?.get ?? none,
    );
  }
  return { Context, Provider, useValue };
}
