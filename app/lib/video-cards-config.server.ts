export const videoCardsEnabled = (env: NodeJS.ProcessEnv = process.env) => env.VIDEO_CARDS === "1";

export function videoCardSource(env: NodeJS.ProcessEnv = process.env) {
  const source = env.VIDEO_CARD_SOURCE || "youtube";
  if (source !== "youtube" && source !== "fake") throw new Error("VIDEO_CARD_SOURCE must be youtube, fake or empty");
  if (source === "fake" && env.NODE_ENV !== "test" && env.NODE_ENV !== "development" && env.TOMOLA_ALLOW_FAKE_ENGINES?.trim() !== "1") {
    throw new Error("Refusing to start with a fake video card source outside a development or test environment. Set TOMOLA_ALLOW_FAKE_ENGINES=1 only on isolated test deployments.");
  }
  return source;
}
