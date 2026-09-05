import { describe, expect, test } from "bun:test"
import { createLock } from "./lock.ts"

describe("createLock", () => {
  test("serializes work on the same key", async () => {
    const lock = createLock()
    const order: number[] = []

    async function first() {
      const release = await lock.acquire("session")
      order.push(1)
      await Promise.resolve()
      order.push(2)
      release()
    }

    async function second() {
      const release = await lock.acquire("session")
      order.push(3)
      release()
    }

    await Promise.all([first(), second()])
    expect(order).toEqual([1, 2, 3])
  })
})
