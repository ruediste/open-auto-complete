import { CompletionManager } from "./completionManager";

describe("findBestCandidate", () => {
  const existingCompletionA = {
    file: "foo.ts",
    offset: 5,
    matchPrefix: "abc",
    availableCompletion: "defg",
    completed: true,
  };
  const existingCompletionB = {
    file: "foo.ts",
    offset: 6,
    matchPrefix: "abcd",
    availableCompletion: "EFG",
    completed: true,
  };

  it("no existing completions", () => {
    expect(
      CompletionManager.findBestCandidate(
        "abc",
        { file: "foo.ts", offset: 5, matchPrefix: "abc" },
        []
      )
    ).toBeUndefined();
  });

  it("match after deletion", () => {
    expect(
      CompletionManager.findBestCandidate(
        "ab",
        { file: "foo.ts", offset: 5, matchPrefix: "ab" },
        [existingCompletionA]
      )
    ).toEqual({
      perfectMatch: false,
      completionStr: "cdefg",
      completion: existingCompletionA,
    });
  });

  it("match after addition", () => {
    expect(
      CompletionManager.findBestCandidate(
        "abcd",
        { file: "foo.ts", offset: 5, matchPrefix: "ab" },
        [existingCompletionA]
      )
    ).toEqual({
      perfectMatch: false,
      completionStr: "efg",
      completion: existingCompletionA,
    });
  });

  it("find perfect match", () => {
    expect(
      CompletionManager.findBestCandidate(
        "abc",
        { file: "foo.ts", offset: 5, matchPrefix: "abc" },
        [existingCompletionA]
      )
    ).toEqual({
      perfectMatch: true,
      completionStr: "defg",
      completion: existingCompletionA,
    });
  });

  it("choose the completion with fewer deletions", () => {
    expect(
      CompletionManager.findBestCandidate(
        "ab",
        { file: "foo.ts", offset: 5, matchPrefix: "ab" },
        [existingCompletionA, existingCompletionB]
      )
    ).toEqual({
      perfectMatch: false,
      completionStr: "cdefg",
      completion: existingCompletionA,
    });
  });
  it("prefer perfect match", () => {
    expect(
      CompletionManager.findBestCandidate(
        "ab",
        { file: "foo.ts", offset: 6, matchPrefix: "abcd" },
        [existingCompletionA, existingCompletionB]
      )
    ).toEqual({
      perfectMatch: true,
      completionStr: "cdEFG",
      completion: existingCompletionB,
    });
  });
});
