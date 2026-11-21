import { Link } from "react-router";
import { LocalTime } from "~/components/local-time";
import type { topArticleReadings, VillageArticleReadingRow, weeklyReadings } from "~/lib/reading-counts.server";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { villagePath } from "~/lib/village-name";
import { m } from "~/paraglide/messages.js";

export function ReadingMetrics({ readings }: { readings: Awaited<ReturnType<typeof weeklyReadings>> }) {
  return <section className="space-y-2">
    <h2 className="text-lg font-semibold">{m.stats_reading_title()}</h2>
    <p>{m.metrics_reading_help()}</p>
    <p>{readings.since ? m.stats_reading_since({ since: readings.since }) : m.stats_unmeasured()}</p>
    <div className="overflow-x-auto"><Table>
      <TableHeader><TableRow><TableHead>{m.metrics_col_week()}</TableHead><TableHead>{m.metrics_reading_source_lang()}</TableHead><TableHead>{m.metrics_reading_read_lang()}</TableHead><TableHead>{m.stats_count()}</TableHead></TableRow></TableHeader>
      <TableBody>{readings.weeks.flatMap(row => row.pairs.length ? row.pairs.map(pair => <TableRow key={`${row.week}:${pair.sourceLang}:${pair.readLang}`}>
        <TableCell>{row.week}</TableCell><TableCell>{pair.sourceLang}</TableCell><TableCell>{pair.readLang}</TableCell><TableCell>{pair.count}</TableCell>
      </TableRow>) : [<TableRow key={row.week}><TableCell>{row.week}</TableCell><TableCell>—</TableCell><TableCell>—</TableCell><TableCell>{row.observed ? "0" : m.stats_unmeasured()}</TableCell></TableRow>])}</TableBody>
    </Table></div>
  </section>;
}


type ArticleReadingMetricsData = Omit<Awaited<ReturnType<typeof topArticleReadings>>, "villages"> & {
  villages: Omit<VillageArticleReadingRow, "systemLang">[] | null;
};

const int = (n: number) => n.toLocaleString("en-US");
const percent = (x: number) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;

export function ArticleReadingMetrics({ readings }: { readings: ArticleReadingMetricsData }) {
  const { start, end, startedAt, articles, concentration, villages } = readings;
  const { publicArticles, readArticles, totalBrowser, topCount, topBrowser, topShare } = concentration;
  const breadth = `${int(readArticles)} / ${int(publicArticles)}`;
  const coverage = publicArticles > 0 ? `${breadth} (${percent(readArticles / publicArticles)})` : breadth;
  const countLabels = [m.stats_reading_browser(), m.metrics_article_reading_original(), m.metrics_article_reading_translated(),
    m.stats_reading_markdown(), "API", "MCP", m.stats_reading_crawler()];
  return <section aria-labelledby="article-reading-metrics" className="space-y-4">
    <h2 id="article-reading-metrics" className="text-lg font-semibold">{m.metrics_article_reading_title()}</h2>
    <p>{m.metrics_article_reading_period({ start, end })}</p>
    {startedAt && <p><LocalTime iso={startedAt.toISOString()} formatLabel={at => m.metrics_article_reading_since({ at })} /></p>}
    <p>{m.metrics_article_reading_help()}</p>
    <div className="space-y-2">
      <h3 id="article-reading-concentration" className="text-base font-semibold">{m.metrics_article_reading_concentration_title()}</h3>
      <p>{m.metrics_article_reading_coverage({ coverage })}</p>
      <p>{topShare !== null && topCount !== null && topBrowser !== null
        ? m.metrics_article_reading_concentration_share({ topCount: int(topCount), readArticles: int(readArticles), share: percent(topShare), topBrowser: int(topBrowser), totalBrowser: int(totalBrowser) })
        : m.metrics_article_reading_concentration_unavailable({ readArticles: int(readArticles) })}</p>
    </div>
    {villages !== null && <div className="space-y-2">
      <h3 id="article-reading-villages" className="text-base font-semibold">{m.metrics_article_reading_villages_title()}</h3>
      <p>{m.metrics_article_reading_villages_help()}</p>
      {villages.length === 0 ? <p>{m.metrics_article_reading_empty()}</p> : <Table aria-labelledby="article-reading-villages">
        <TableHeader><TableRow>
          {[m.metrics_article_reading_village(), m.metrics_article_reading_articles(), ...countLabels]
            .map(label => <TableHead key={label} scope="col">{label}</TableHead>)}
        </TableRow></TableHeader>
        <TableBody>{villages.map(row => <TableRow key={`${row.kind}:${row.slug ?? ""}`}>
          <TableCell className="max-w-xs whitespace-normal break-words">{row.kind === "shared"
            ? <Link to={villagePath(row.slug)} className="underline">{row.name}</Link>
            : row.kind === "personal" ? m.metrics_article_reading_personal_villages() : m.metrics_article_reading_no_village()}</TableCell>
          {[row.articles, row.browser, row.browser - row.translated, row.translated, row.markdown, row.api, row.mcp, row.crawler]
            .map((count, index) => <TableCell key={index} className="tabular-nums">{int(count)}</TableCell>)}
        </TableRow>)}</TableBody>
      </Table>}
    </div>}
    <div className="space-y-2">
      <h3 id="article-reading-top" className="text-base font-semibold">{m.metrics_article_reading_top_title()}</h3>
      {articles.length === 0 ? <p>{m.metrics_article_reading_empty()}</p> : <div className="overflow-x-auto"><Table aria-labelledby="article-reading-top">
        <TableHeader><TableRow>
          {[m.metrics_article_reading_article(), ...countLabels].map(label => <TableHead key={label} scope="col">{label}</TableHead>)}
        </TableRow></TableHeader>
        <TableBody>{articles.map(row => <TableRow key={row.id}>
          <TableCell className="max-w-xs whitespace-normal break-words"><Link to={`/t/${row.id}`} className="underline">{row.title || m.headline_empty()}</Link></TableCell>
          {[row.browser, row.browser - row.translated, row.translated, row.markdown, row.api, row.mcp, row.crawler]
            .map((count, index) => <TableCell key={index} className="tabular-nums">{count}</TableCell>)}
        </TableRow>)}</TableBody>
      </Table></div>}
    </div>
  </section>;
}
