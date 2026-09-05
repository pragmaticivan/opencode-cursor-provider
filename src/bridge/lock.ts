export function createLock() {
  const locks = new Map<string, Promise<void>>()

  return async function* locked<T>(key: string, run: () => AsyncIterable<T>): AsyncGenerator<T> {
    const previous = locks.get(key) ?? Promise.resolve()
    let release = () => {}
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    locks.set(
      key,
      previous.then(() => current),
    )
    await previous
    try {
      yield* run()
    } finally {
      release()
      if (locks.get(key) === current) locks.delete(key)
    }
  }
}
