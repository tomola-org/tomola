export const POST_NOTICE_PARAMS = ["posted", "edited", "followed"] as const;
export const REAUTH_RETURN_PARAM = "reverified";
export const NOTICE_PARAMS = [...POST_NOTICE_PARAMS, REAUTH_RETURN_PARAM] as const;

export function pathWithoutNoticeParams(pathname: string, search: string, hash = ""): string {
  if (!search) return pathname + hash;
  const params = new URLSearchParams(search);
  if (!NOTICE_PARAMS.some(name => params.has(name))) return pathname + search + hash;
  for (const name of NOTICE_PARAMS) params.delete(name);
  return pathname + (params.size ? `?${params}` : "") + hash;
}
