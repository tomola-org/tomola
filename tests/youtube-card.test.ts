import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarkdown } from "~/lib/markdown.core.server";
import { videoCardHtml, videoIdsInHtml } from "~/lib/video-card-html.server";
import { videoCardSource } from "~/lib/video-cards-config.server";
import { fetchYoutubeCard, loadYoutubeArtwork, VIDEO_FETCH_LIMITS } from "~/lib/youtube-fetch.server";
import { youtubeIdsInMarkdown } from "~/lib/youtube-markdown.core.server";
import { parseYoutubeUrl, youtubeWatchUrl } from "~/lib/youtube-url";

const id = "A1b2C3d4_-E";
const url = youtubeWatchUrl(id);

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

afterEach(() => vi.unstubAllGlobals());

describe("standalone YouTube video links", () => {
  it.each([
    `https://youtube.com/watch?v=${id}&t=50&list=example`,
    `https://www.youtube.com/watch?t=50&v=${id}`,
    `https://m.youtube.com/watch?v=${id}#t=50`,
    `https://www.youtube.com/shorts/${id}?list=example`,
    `https://youtube.com/live/${id}?t=26`,
    `https://youtu.be/${id}?t=13&list=example`,
    `http://youtu.be/${id}`,
  ])("preserves the destination of %s", value => {
    expect(parseYoutubeUrl(value)).toEqual({ id, href: value.replace(/^http:/, "https:") });
  });

  it.each(["www.youtube.com", "m.youtube.com", "www.youtube-nocookie.com"])("uses an ordinary watch page for %s embeds", host => {
    expect(parseYoutubeUrl(`https://${host}/embed/${id}?t=15&start=60&list=example&autoplay=1`))
      .toEqual({ id, href: `${url}&t=15&list=example` });
    expect(parseYoutubeUrl(`https://${host}/embed/${id}?start=60&list=example`))
      .toEqual({ id, href: `${url}&t=60&list=example` });
  });

  it.each([
    `https://youtube.com.example/watch?v=${id}`, `https://notyoutube.com/watch?v=${id}`, `https://youtube.com@elsewhere.example/watch?v=${id}`,
    `https://example.invalid@youtube.com/watch?v=${id}`, `https://www.youtube.com:81/watch?v=${id}`, `https://www.youtube.com/other?v=${id}`,
    `https://www.youtube.com/other/../watch?v=${id}`, `https://www.youtube.com/shorts/${id}/other`, `https://youtu.be/${id}/`,
    `https://www.youtube-nocookie.com/watch?v=${id}`, `https://www.youtube.com/watch?v=${id}1`, `https://youtu.be/${id.slice(1)}`,
  ])("rejects %s", value => expect(parseYoutubeUrl(value)).toBeNull());

  it("identifies the first ten standalone URL paragraphs using the same Markdown grammar as rendering", () => {
    const ordinary = [
      `Before ${url}`, `${url}\nAfter`, `- ${url}`, `> ${url}`, `[Watch this](${url})`,
      `| Video |\n| --- |\n| ${url} |`, `\`${url}\``, `[${url}](${url} "title")`,
      `[${url}][video]\n\n[video]: ${url}`,
    ];
    const body = [...ordinary, url, `<${url}>`, `[${url}](${url})`, ...Array.from({ length: 7 }, () => url), "https://youtu.be/ExtraVideo1"].join("\n\n");
    const rendered = renderMarkdown(body, { videoLinks: true });
    expect(youtubeIdsInMarkdown(body)).toEqual([id]);
    expect(videoIdsInHtml(rendered)).toEqual(Array(10).fill(id));
    expect(videoCardHtml(rendered)).toBe(renderMarkdown(body));
  });

  it("renders escaped metadata, a same-site image and a note in translated bodies only", () => {
    const authored = `https://www.youtube-nocookie.com/embed/${id}?start=120&list=example`;
    const video = { title: '<img src="https://example.invalid/track"> & title', channel: "Example & channel", width: 180, height: 320 };
    const cards = new Map([[id, video]]);
    const rendered = renderMarkdown(authored, { videoLinks: true });
    const original = videoCardHtml(rendered, cards, "ja");
    expect(original).toContain(`src="/media/youtube-${id}.webp" alt="" width="180" height="320" loading="lazy"`);
    expect(original).toMatch(/href="https:\/\/www\.youtube\.com\/watch\?v=A1b2C3d4_-E(?:&amp;|&#x26;)t=120(?:&amp;|&#x26;)list=example"/);
    expect(original).toContain('<bdi class="video-card-title" translate="no">&lt;img src=&quot;');
    expect(original).toContain('<bdi translate="no">Example &amp; channel</bdi>');
    expect(original.match(/<img /g)).toHaveLength(1);
    expect(original).toContain("YouTube で見る");
    expect(original).not.toContain("video-card-note");
    expect(videoCardHtml(rendered, cards, "en", true)).toContain("The video is in its original language");
    expect(videoCardHtml(rendered)).toBe(renderMarkdown(authored));
  });
});

describe("YouTube metadata acquisition", () => {
  const metadata = { title: " A\u0000B ", author_name: "x".repeat(101), html: "<iframe></iframe>", thumbnail_url: `https://i.ytimg.com/vi/${id}/ignored.jpg` };

  it("requests just the two fixed destinations without redirects or credentials", async () => {
    const take = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(metadata)).mockResolvedValueOnce(new Response("image"));
    expect(await fetchYoutubeCard(id, { fetch: take })).toEqual({ title: "AB", channel: "x".repeat(100), bytes: Buffer.from("image") });
    const calls = take.mock.calls;
    const embed = new URL(String(calls[0][0]));
    expect(embed.origin + embed.pathname).toBe("https://www.youtube.com/oembed");
    expect([...embed.searchParams]).toEqual([["format", "json"], ["url", url]]);
    expect(calls.map(([target]) => new URL(String(target)).host)).toEqual(["www.youtube.com", "i.ytimg.com"]);
    expect(calls[1][0]).toBe(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
    for (const [, init] of calls) expect(init).toMatchObject({ redirect: "error", credentials: "omit" });
  });

  it.each([400, 401, 403, 404, 410])("treats HTTP %s as unavailable", async status => {
    const take = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
    await expect(fetchYoutubeCard(id, { fetch: take })).resolves.toBeNull();
    expect(take).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["malformed JSON", "{"],
    ["a blank channel", JSON.stringify({ ...metadata, author_name: " \u0000 " })],
    ["a missing title", JSON.stringify({ ...metadata, title: undefined })],
  ])("treats %s as unavailable without requesting the image", async (_case, json) => {
    const take = vi.fn<typeof fetch>().mockResolvedValue(new Response(json));
    await expect(fetchYoutubeCard(id, { fetch: take })).resolves.toBeNull();
    expect(take).toHaveBeenCalledTimes(1);
  });

  it("lets the worker retry temporary HTTP failures", async () => {
    const take = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    await expect(fetchYoutubeCard(id, { fetch: take })).rejects.toThrow("HTTP 503");
  });

  it("rejects redirects and a thumbnail from another host", async () => {
    const redirect = vi.fn<typeof fetch>().mockResolvedValue(Response.redirect("https://example.invalid/"));
    await expect(fetchYoutubeCard(id, { fetch: redirect })).rejects.toThrow("HTTP 302");
    expect(redirect).toHaveBeenCalledTimes(1);
    const foreign = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...metadata, thumbnail_url: "https://example.invalid/image.jpg" }));
    await expect(fetchYoutubeCard(id, { fetch: foreign })).rejects.toThrow("unexpected thumbnail URL");
    expect(foreign).toHaveBeenCalledTimes(1);
  });

  it("bounds the JSON, image and download time", async () => {
    const json = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(VIDEO_FETCH_LIMITS.oembed + 1)));
    await expect(fetchYoutubeCard(id, { fetch: json })).rejects.toThrow("size limit");
    const image = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(metadata))
      .mockResolvedValueOnce(new Response("image", { headers: { "content-length": String(VIDEO_FETCH_LIMITS.image + 1) } }));
    await expect(fetchYoutubeCard(id, { fetch: image })).rejects.toThrow("size limit");
    const stuck = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); } });
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      await expect(fetchYoutubeCard(id, { timeoutMs: 20, fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(stuck)) })).rejects.toHaveProperty("name", "TimeoutError");
    } finally { clearTimeout(keepAlive); }
  });

  it("decodes the fake image locally and rejects the fake source on normal production startup", async () => {
    const take = vi.fn<typeof fetch>().mockRejectedValue(new Error("unexpected request"));
    vi.stubGlobal("fetch", take);
    expect((await loadYoutubeArtwork(id, "fake"))?.bytes.toString("ascii", 8, 12)).toBe("WEBP");
    expect(take).not.toHaveBeenCalled();
    expect(() => videoCardSource({ NODE_ENV: "production", VIDEO_CARD_SOURCE: "fake" })).toThrow("Refusing to start");
    expect(videoCardSource({ NODE_ENV: "production", VIDEO_CARD_SOURCE: "fake", TOMOLA_ALLOW_FAKE_ENGINES: "1" })).toBe("fake");
  });
});
