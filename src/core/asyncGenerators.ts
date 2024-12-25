export class AsyncGenerators {
  static async *tap<T>(
    input: AsyncGenerator<T>,
    action: (item: T) => void,
    end?: () => void
  ): AsyncGenerator<T> {
    try {
      for await (const item of input) {
        action(item);
        yield item;
      }
    } finally {
      end?.();
    }
  }
}
