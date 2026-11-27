import { SHARE_LANG_PARAM } from "./share-language";
import { NOTICE_PARAMS } from "./notice-params";

export function topicPageKey(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  for (const name of NOTICE_PARAMS) params.delete(name);
  params.delete(SHARE_LANG_PARAM);
  params.sort();
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}
