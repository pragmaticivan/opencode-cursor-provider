import { expect, test } from "bun:test"
import { watchModels } from "./plugin.ts"

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: Deferred<T>["resolve"] = () => {
    throw new Error("Deferred promise was not initialized")
  }
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

test("model watcher cleanup waits for refresh and blocks buffered triggers", async () => {
  const activeRefresh = deferred<void>()
  const bufferedEvent = deferred<void>()
  const closeStarted = deferred<void>()
  let linked: () => void = () => {
    throw new Error("Linked callback was not registered")
  }
  let refreshes = 0
  let closes = 0
  let unlinks = 0
  let subscriptionSawAbort = false
  let cleanupFinished = false
  const stop = watchModels({
    onLinked(listener) {
      linked = listener
      return () => {
        unlinks += 1
      }
    },
    async *subscribe(signal) {
      await bufferedEvent.promise
      subscriptionSawAbort = signal.aborted
      yield { type: "credential.updated" }
    },
    refresh() {
      refreshes += 1
      return activeRefresh.promise
    },
    async close() {
      closes += 1
      closeStarted.resolve()
      await activeRefresh.promise
    },
  })

  const cleanup = stop().then(() => {
    cleanupFinished = true
  })
  linked()
  bufferedEvent.resolve()
  await closeStarted.promise

  expect(refreshes).toBe(1)
  expect(cleanupFinished).toBe(false)

  activeRefresh.resolve()
  await Promise.all([cleanup, stop()])

  expect(closes).toBe(1)
  expect(unlinks).toBe(1)
  expect(subscriptionSawAbort).toBe(true)
  expect(cleanupFinished).toBe(true)
})
