import { SHARE_LANG_PARAM } from "./share-language";

export function topicPageKey(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  for (const name of ["posted", "edited", "followed", SHARE_LANG_PARAM]) params.delete(name);
  params.sort();
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
