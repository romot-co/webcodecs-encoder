/**
 * @vitest-environment node
 */
import { test, expect } from "vitest";
import { chromium, Browser, Page } from "playwright";
import { execSync } from "child_process";
import { writeFileSync, readFileSync, existsSync } from "fs";
import path from "path";
import http from "http";

/* eslint-disable no-console */

async function findAvailablePort(startPort: number): Promise<number> {
  const server = http.createServer();
  return new Promise((resolve, reject) => {
    server.on("error", (e: any) => {
      if (e.code === "EADDRINUSE") {
        resolve(findAvailablePort(startPort + 1));
      } else {
        reject(e);
      }
    });
    server.listen(startPort, () => {
      server.close(() => resolve(startPort));
    });
  });
}

function startHttpServer(port: number, rootDir: string): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let filePath = path.join(rootDir, req.url || "");
      if (filePath.endsWith("/")) filePath = path.join(filePath, "index.html");
      if (!existsSync(filePath) && req.url?.endsWith(".html")) {
        const potential = path.join(rootDir, req.url || "");
        if (existsSync(potential)) filePath = potential;
      }
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (existsSync(filePath)) {
        const ext = path.extname(filePath);
        let contentType = "text/html";
        if (ext === ".js") contentType = "application/javascript";
        const content = readFileSync(filePath);
        res.writeHead(200, { "Content-Type": contentType });
        res.end(content);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });
    server.listen(port, () => resolve(server));
  });
}

test("MediaStreamRecorder works in browser", async () => {
  let browser: Browser | null = null;
  let page: Page | null = null;
  let server: http.Server | null = null;
  let port: number;

  try {
    execSync("npm run build", { stdio: "inherit" });
    port = await findAvailablePort(8900);
    const distDir = path.join(__dirname, "../../dist");
    const htmlPath = path.join(distDir, "mediastream-recorder-test.html");

    const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>MediaStreamRecorder Test</title>
        <script type="module">
          import { MediaStreamRecorder } from './index.js';
          window.runRecorderTest = async function() {
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
              const recorder = new MediaStreamRecorder({
                width: 320,
                height: 240,
                frameRate: 30,
                videoBitrate: 1_000_000,
                audioBitrate: 128_000,
                sampleRate: 48000,
                channels: 1
              });
              await recorder.startRecording(stream);
              await new Promise(r => setTimeout(r, 1000));
              const data = await recorder.stopRecording();
              window.recorderResult = { success: true, byteLength: data ? data.byteLength : 0 };
            } catch (e) {
              window.recorderResult = { success: false, error: e instanceof Error ? e.message : String(e) };
            }
          };
          window.runRecorderTest();
        </script>
      </head>
      <body>
        <h1>MediaStreamRecorder Test</h1>
      </body>
    </html>`;

    writeFileSync(htmlPath, html);
    server = await startHttpServer(port, distDir);

    browser = await chromium.launch({
      headless: process.env.HEADLESS === "true",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--enable-logging=stderr",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
    });

    page = await browser.newPage();
    page.on("console", (msg) =>
      console.log(`[Browser Console]: ${msg.text()}`),
    );
    page.on("pageerror", (err) =>
      console.error(`[Browser Error]: ${err.message}`),
    );
    await page.goto(`http://localhost:${port}/mediastream-recorder-test.html`);

    await page.waitForFunction(
      () => (window as any).recorderResult !== undefined,
      { timeout: 30000 },
    );
    const result = await page.evaluate(() => (window as any).recorderResult);

    expect(result.success).toBe(true);
    expect(result.byteLength).toBeGreaterThan(0);
  } finally {
    if (page) await page.close();
    if (browser) await browser.close();
    if (server) server.close();
  }
}, 60000);

/* eslint-enable no-console */
