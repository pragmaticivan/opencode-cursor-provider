export interface KeyedLock {
  acquire(key: string): Promise<() => void>
}

export function createLock(): KeyedLock {
  const locks = new Map<string, Promise<void>>()

  return {
    async acquire(key) {
      const previous = locks.get(key) ?? Promise.resolve()
      let releaseCurrent = () => {}
      const current = new Promise<void>((resolve) => {
        releaseCurrent = resolve
      })
      const queued = previous.then(() => current)
      locks.set(key, queued)
      await previous

      let released = false
      return () => {
        if (released) return
        released = true
        releaseCurrent()
        if (locks.get(key) === queued) locks.delete(key)
      }
    },
  }
}
