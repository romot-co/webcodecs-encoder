/**
 * @vitest-environment node
 */
import { test, afterAll, expect } from "vitest";
import puppeteer from "puppeteer";
import { readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

let browser: any = null;

afterAll(async () => {
  if (browser) {
    await browser.close();
  }
});

test.concurrent("encodes video and audio in browser", async () => {
  // Build the library to ensure dist/index.mjs exists
  execSync("npm run build", { stdio: "inherit" });
  const distPath = join(__dirname, "../../dist/index.mjs");
  const code = readFileSync(distPath, "utf8");
  const moduleCode = Buffer.from(code).toString("base64");

  browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto("about:blank");

  const result = await page.evaluate(async (encoded: string) => {
    const { WebCodecsEncoder } = await import(
      `data:text/javascript;base64,${encoded}`
    );

    const config = {
      width: 64,
      height: 64,
      frameRate: 5,
      videoBitrate: 100_000,
      audioBitrate: 64_000,
      sampleRate: 48000,
      channels: 1,
    } as const;

    const encoder = new WebCodecsEncoder(config);
    await encoder.initialize();

    const canvas = document.createElement("canvas");
    canvas.width = config.width;
    canvas.height = config.height;
    const ctx = canvas.getContext("2d")!;
    for (let i = 0; i < 2; i++) {
      ctx.fillStyle = `rgb(${i * 20}, 0, 0)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await encoder.addCanvasFrame(canvas);
    }

    const audioCtx = new AudioContext({ sampleRate: config.sampleRate });
    const buffer = audioCtx.createBuffer(
      config.channels,
      audioCtx.sampleRate / 2,
      audioCtx.sampleRate,
    );
    await encoder.addAudioBuffer(buffer);

    const data = await encoder.finalize();
    return Array.from(data);
  }, moduleCode);

  const uint8 = Uint8Array.from(result as number[]);
  expect(uint8.byteLength).toBeGreaterThan(0);
  expect(uint8[0] === 0x00 || uint8[0] === 0x1a).toBe(true);
});
