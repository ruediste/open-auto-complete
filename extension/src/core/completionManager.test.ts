import { CompletionManager } from "./completionManager";

describe("findBestCandidate", () => {
  const existingCompletionA = {
    matchPrefix: "abc",
    availableResponse: "defg",
  };
  const existingCompletionB = {
    matchPrefix: "abcd",
    availableResponse: "EFGH",
  };

  it("no existing completions", () => {
    expect(CompletionManager.findBestCandidate("abc", [])).toBeUndefined();
  });

  it("match after deletion", () => {
    expect(
      CompletionManager.findBestCandidate("ab", [existingCompletionA])
    ).toEqual({
      generationRequired: true,
      completionStr: "cdefg",
      completion: existingCompletionA,
    });
  });

  it("match after addition", () => {
    expect(
      CompletionManager.findBestCandidate("abcd", [existingCompletionA])
    ).toEqual({
      generationRequired: false,
      completionStr: "efg",
      completion: existingCompletionA,
    });
  });

  it("find no negative cursor change", () => {
    expect(
      CompletionManager.findBestCandidate("abc", [existingCompletionA])
    ).toEqual({
      generationRequired: false,
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
      generationRequired: true,
      completionStr: "cdefg",
      completion: existingCompletionA,
    });
  });
});
