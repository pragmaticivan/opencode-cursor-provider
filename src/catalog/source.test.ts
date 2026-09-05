import { AuthenticationError } from "@cursor/sdk"
import { describe, expect, test } from "bun:test"
import { asApiKey, type CursorApiKey } from "../ids.ts"
import { SEED_MODELS } from "./catalog.ts"
import { createModelSource, type ModelSourceDependencies } from "./source.ts"

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
  readonly reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: Deferred<T>["resolve"] = () => {
    throw new Error("Deferred promise was not initialized")
  }
  let reject: Deferred<T>["reject"] = () => {
    throw new Error("Deferred promise was not initialized")
  }
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

describe("createModelSource", () => {
  test("resets a listed snapshot after credentials disconnect", async () => {
    let apiKey: CursorApiKey | undefined = asApiKey("cursor_live")
    let reloads = 0
    const dependencies: ModelSourceDependencies = {
      async restoreCredential() {},
      async resolveApiKey() {
        return apiKey
      },
      rejectCredential() {},
      async reloadCatalog() {
        reloads += 1
      },
      async listModels() {
        return [{ id: "listed-model", displayName: "Listed Model" }]
      },
    }
    const source = createModelSource(dependencies)
    await source.refresh()
    apiKey = undefined

    const models = await source.refresh().then(() => source.list())

    expect(models).toEqual(SEED_MODELS)
    expect(reloads).toBe(2)
  })

  test("resets a listed snapshot after authentication fails", async () => {
    let rejectedCredentials = 0
    let reloads = 0
    let listModels: (apiKey: CursorApiKey) => Promise<unknown> = async () => [
      { id: "listed-model", displayName: "Listed Model" },
    ]
    const dependencies: ModelSourceDependencies = {
      async restoreCredential() {},
      async resolveApiKey() {
        return asApiKey("cursor_live")
      },
      rejectCredential() {
        rejectedCredentials += 1
      },
      async reloadCatalog() {
        reloads += 1
      },
      async listModels(apiKey) {
        return listModels(apiKey)
      },
    }
    const source = createModelSource(dependencies)
    await source.refresh()
    listModels = async () => {
      throw new AuthenticationError("expired credential")
    }

    const models = await source.refresh().then(() => source.list())

    expect(models).toEqual(SEED_MODELS)
    expect(rejectedCredentials).toBe(1)
    expect(reloads).toBe(2)
  })

  test("retains seeds after authentication and transient list errors", async () => {
    let listing = 0
    const dependencies: ModelSourceDependencies = {
      async restoreCredential() {},
      async resolveApiKey() {
        return asApiKey("cursor_live")
      },
      rejectCredential() {},
      async reloadCatalog() {},
      async listModels() {
        listing += 1
        if (listing === 1) return [{ id: "listed-model", displayName: "Listed Model" }]
        if (listing === 2) throw new AuthenticationError("expired credential")
        throw new Error("Cursor is unavailable")
      },
    }
    const source = createModelSource(dependencies)
    await source.refresh()
    await source.refresh()

    const models = await source.refresh().then(() => source.list())

    expect(models).toEqual(SEED_MODELS)
  })

  test("serializes refreshes and coalesces them into one trailing refresh", async () => {
    const firstListing = deferred<unknown>()
    let listingCalls = 0
    let activeListings = 0
    let maximumActiveListings = 0
    const dependencies: ModelSourceDependencies = {
      async restoreCredential() {},
      async resolveApiKey() {
        return asApiKey("cursor_live")
      },
      rejectCredential() {},
      async reloadCatalog() {},
      async listModels() {
        listingCalls += 1
        activeListings += 1
        maximumActiveListings = Math.max(maximumActiveListings, activeListings)
        const listed = listingCalls === 1 ? await firstListing.promise : []
        activeListings -= 1
        return listed
      },
    }
    const source = createModelSource(dependencies)
    const firstRefresh = source.refresh()
    await Promise.resolve()
    const secondRefresh = source.refresh()
    const thirdRefresh = source.refresh()
    firstListing.resolve([])

    const completed = await Promise.all([firstRefresh, secondRefresh, thirdRefresh])

    expect(completed).toEqual([undefined, undefined, undefined])
    expect(listingCalls).toBe(2)
    expect(maximumActiveListings).toBe(1)
  })

  test("retries a dirty catalog reload on the next refresh", async () => {
    let reloads = 0
    let listings = 0
    let reloadCatalog: ModelSourceDependencies["reloadCatalog"] = async () => {
      reloads += 1
      throw new Error("catalog busy")
    }
    const dependencies: ModelSourceDependencies = {
      async restoreCredential() {},
      async resolveApiKey() {
        return asApiKey("cursor_live")
      },
      rejectCredential() {},
      async reloadCatalog() {
        return reloadCatalog()
      },
      async listModels() {
        listings += 1
        if (listings > 1) throw new Error("Cursor is unavailable")
        return [{ id: "listed-model", displayName: "Listed Model" }]
      },
    }
    const source = createModelSource(dependencies)
    await source.refresh()
    reloadCatalog = async () => {
      reloads += 1
    }

    const models = await source.refresh().then(() => source.list())

    expect(models.map((model) => model.name)).toContain("Listed Model")
    expect(reloads).toBe(2)
  })

  test("close waits for trailing work and blocks new refreshes", async () => {
    const firstListing = deferred<unknown>()
    const trailingListing = deferred<unknown>()
    const events: string[] = []
    let listingCalls = 0
    const dependencies: ModelSourceDependencies = {
      async restoreCredential() {},
      async resolveApiKey() {
        return asApiKey("cursor_live")
      },
      rejectCredential() {},
      async reloadCatalog() {},
      async listModels() {
        listingCalls += 1
        events.push(`list-${listingCalls}-started`)
        const listed = await (listingCalls === 1 ? firstListing.promise : trailingListing.promise)
        events.push(`list-${listingCalls}-finished`)
        return listed
      },
    }
    const source = createModelSource(dependencies)
    const activeRefresh = source.refresh()
    await Promise.resolve()
    const trailingRefresh = source.refresh()
    const closing = source.close().then(() => {
      events.push("closed")
    })
    const repeatedClosing = source.close()
    const blockedRefresh = source.refresh()
    firstListing.resolve([])
    trailingListing.resolve([])

    const completed = await Promise.all([activeRefresh, trailingRefresh, closing, repeatedClosing, blockedRefresh])

    expect(completed).toEqual([undefined, undefined, undefined, undefined, undefined])
    expect(listingCalls).toBe(2)
    expect(events).toEqual([
      "list-1-started",
      "list-1-finished",
      "list-2-started",
      "list-2-finished",
      "closed",
    ])
  })
})
