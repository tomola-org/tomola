import { expect, it } from "vitest";
import { topicPageKey } from "~/lib/topic-page";

it("ignores notices and share-language hints and orders parameters by name", () => {
  const key = topicPageKey("/t/12", "?lang=fr&orig=4&orig=9&rl=1");
  expect(topicPageKey("/t/12", "?edited=12&orig=4&rl=1&posted=12&lang=fr&sl=ja&orig=9&followed=1")).toBe(key);
  expect(topicPageKey("/t/12", "?orig=4&orig=9&lang=fr&rl=1&posted=9&edited=8&followed=0&sl=en")).toBe(key);
});

it("distinguishes topic paths and the relative order of repeated values", () => {
  const key = topicPageKey("/t/12", "?orig=4&orig=9");
  expect(topicPageKey("/t/42", "?orig=4&orig=9")).not.toBe(key);
  expect(topicPageKey("/t/12", "?orig=9&orig=4")).not.toBe(key);
  expect(topicPageKey("/t/12", "?orig=4")).not.toBe(key);
});

it.each(["lang", "rl", "orig", "tr", "old", "page", "tag", "extra"])("keeps changes to %s in the key", name => {
  expect(topicPageKey("/t/12", `?${name}=before`)).not.toBe(topicPageKey("/t/12", `?${name}=after`));
});
