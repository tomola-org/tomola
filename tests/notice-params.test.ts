import { expect, it } from "vitest";
import { pathWithoutNoticeParams } from "~/lib/notice-params";

it("drops only notice parameters from a return path", () => {
  const path = pathWithoutNoticeParams("/t/5", "?lang=fr&posted=5&edited=7&followed=1&reverified=1&page=2&page=3&reverified=0", "#c-9");
  expect(path).toBe("/t/5?lang=fr&page=2&page=3#c-9");
});

it("keeps the fragment with or without a remaining query", () => {
  expect(pathWithoutNoticeParams("/mod", "?reverified=1", "#reports")).toBe("/mod#reports");
  expect(pathWithoutNoticeParams("/mod", "?q=a%20b", "#reports")).toBe("/mod?q=a%20b#reports");
});
