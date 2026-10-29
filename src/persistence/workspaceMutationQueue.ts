export class WorkspaceMutationQueue {
  #pending: Promise<void> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(operation)
    this.#pending = result.then(() => undefined, () => undefined)
    return result
  }

  flush(): Promise<void> {
    return this.#pending
  }
}
