import { PerformanceEvaluationService } from "./PerformanceEvaluationService";

describe("PerformanceEvaluationService", () => {
  it("should generate correct completions", () => {
    const getCompletion = PerformanceEvaluationService.getCompletion;
    expect(getCompletion("foo.bar")).toBe("foo.");
    expect(getCompletion("bar")).toBe("bar");
    expect(getCompletion(" foo.bar")).toBe(" foo.");
    expect(getCompletion("-foo+2")).toBe("-");
  });
});
