import type { ReactNode } from "react";
import { Link } from "react-router";
import { AuthorLink } from "~/components/author-link";
import { villageName } from "~/lib/village-name";
import { villageNameTitle, type WithVillageTranslation } from "~/lib/village-translation-view";
import type { PublicVillage } from "~/lib/villages.server";

type Author = { handle: string; name?: string | null; latin?: string | null; reader?: boolean };

export function ArticleByline({ details, more, ...author }: Author & { details: ReactNode; more?: ReactNode }) {
  return <div className="reading-byline" data-reading-byline="">
    <div className="article-author">
      <AuthorLink {...author} byline handleClassName="article-author-handle" />
    </div>
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 ui-meta text-muted-foreground">{details}</div>
    {more}
  </div>;
}

export function ArticleSignature(author: Author) {
  return <p className="article-signature" data-article-signature="">
    <AuthorLink {...author} byline handleClassName="article-author-handle" />
  </p>;
}

export function ArticleVillageLink({ village, className = "link-ui underline" }: { village?: (PublicVillage & WithVillageTranslation) | null; className?: string }) {
  if (!village || village.kind === "personal" || village.language) return null;
  return <Link to={`/v/${village.slug}`} title={villageNameTitle(village)} className={className}>{villageName(village)}</Link>;
}
