import { Position, Range } from "vscode";

export async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function programmaticPromise<T>(): [
  Promise<T>,
  (value: T | PromiseLike<T>) => void,
  (reason?: any) => void
] {
  let resolve: (value: T | PromiseLike<T>) => void;
  let reject: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return [promise, resolve!, reject!];
}

export class ProgrammaticPromise<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T | PromiseLike<T>) => void;
  reject!: (reason?: any) => void;

  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

export function formatPosition(position: Position) {
  return `${position.line + 1}:${position.character + 1}`;
}

export function formatRange(range: Range) {
  return `${formatPosition(range.start)}-${formatPosition(range.end)}`;
}
