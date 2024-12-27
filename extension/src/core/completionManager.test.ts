import { CompletionManager } from "./completionManager";

describe("findBestCandidate", () => {
  const existingCompletionA = {
    file: "foo.ts",
    offset: 5,
    matchPrefix: "abc",
    availableResponse: "defg",
    completed: true,
  };
  const existingCompletionB = {
    file: "foo.ts",
    offset: 6,
    matchPrefix: "abcd",
    availableResponse: "EFG",
    completed: true,
  };

  it("no existing completions", () => {
    expect(CompletionManager.findBestCandidate("abc", [])).toBeUndefined();
  });

  it("match after deletion", () => {
    expect(
      CompletionManager.findBestCandidate("ab", [existingCompletionA])
    ).toEqual({
      perfectMatch: false,
      completionStr: "cdefg",
      completion: existingCompletionA,
    });
  });

  it("match after addition", () => {
    expect(
      CompletionManager.findBestCandidate("abcd", [existingCompletionA])
    ).toEqual({
      perfectMatch: false,
      completionStr: "efg",
      completion: existingCompletionA,
    });
  });

  it("find perfect match", () => {
    expect(
      CompletionManager.findBestCandidate("abc", [existingCompletionA])
    ).toEqual({
      perfectMatch: true,
      completionStr: "defg",
      completion: existingCompletionA,
    });
  });

  it("choose the completion with fewer deletions", () => {
    expect(
      CompletionManager.findBestCandidate("ab", [
        existingCompletionA,
        existingCompletionB,
      ])
    ).toEqual({
      perfectMatch: false,
      completionStr: "cdefg",
      completion: existingCompletionA,
    });
  });
  it("prefer perfect match", () => {
    expect(
      CompletionManager.findBestCandidate("ab", [
        existingCompletionA,
        existingCompletionB,
      ])
    ).toEqual({
      perfectMatch: true,
      completionStr: "cdEFG",
      completion: existingCompletionB,
    });
  });
});
