import { CompletionFilterService } from "./completionFilterService";
import { NopLogManager } from "./logger";

describe("completionFilter", () => {
  const service = new CompletionFilterService(new NopLogManager());

  it("should include next word", async () => {
    expect(await service.applyFilters(".foo(bar")).toBe(".");
    expect(await service.applyFilters("foo(bar")).toBe("foo(");
    expect(await service.applyFilters("foo\nconsole")).toBe("foo");
    expect(await service.applyFilters(");\nconsole")).toBe(");");
  });
});
