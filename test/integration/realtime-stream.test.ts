/**
 * @vitest-environment node
 */
import { test, expect } from "vitest";
import { chromium, Browser, Page } from "playwright";
import { execSync } from "child_process";
import { writeFileSync, readFileSync } from "fs";
import path from "path";
import http from "http";
import { existsSync } from "fs";

/* eslint-disable no-console */

async function findAvailablePort(startPort: number): Promise<number> {
  const port = startPort;
  const server = http.createServer();
  return new Promise((resolve, reject) => {
    server.on("error", (e: any) => {
      if (e.code === "EADDRINUSE") {
        resolve(findAvailablePort(startPort + 1));
      } else {
        reject(e);
      }
    });
    server.listen(port, () => {
      server.close(() => resolve(port));
    });
  });
}

function startHttpServer(port: number, rootDir: string): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/favicon.ico") {
        res.writeHead(204, { "Content-Type": "image/x-icon" });
        res.end();
        return;
      }
      let filePath = path.join(rootDir, req.url || "");
      if (filePath.endsWith("/")) {
        filePath = path.join(filePath, "index.html");
      } else if (!existsSync(filePath) && req.url?.endsWith(".html")) {
        const potentialPath = path.join(rootDir, req.url || "");
        if (existsSync(potentialPath)) {
          filePath = potentialPath;
        }
      }
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      if (existsSync(filePath)) {
        const extname = path.extname(filePath);
        let contentType = "text/html";
        switch (extname) {
          case ".js":
            contentType = "application/javascript";
            break;
          case ".css":
            contentType = "text/css";
            break;
        }
        const content = readFileSync(filePath);
        res.writeHead(200, { "Content-Type": contentType });
        res.end(content, "utf-8");
      } else {
        res.writeHead(404);
        res.end("File not found: " + filePath);
      }
    });
    server.listen(port, () => resolve(server));
  });
}

// Integration test for realtime streaming

test("realtime encoding streams data to MediaSource", async () => {
  let browser: Browser | null = null;
  let page: Page | null = null;
  let server: http.Server | null = null;
  let port: number;

  try {
    console.log("Building library...");
    execSync("npm run build", { stdio: "inherit" });
    execSync(
      "npx tsup src/index.ts --format iife --globalName WebCodecsEncoder",
      { stdio: "inherit" },
    );
    console.log("Library built");

    const distDir = path.join(__dirname, "../../dist");
    const tempDir = path.join(distDir, "temp-html");
    execSync(`mkdir -p ${tempDir}`);
    const timestamp = Date.now();
    const htmlFilename = `realtime-test-${timestamp}.html`;
    const htmlPath = path.join(tempDir, htmlFilename);

    const bundleCode = readFileSync(
      path.join(distDir, "index.global.js"),
      "utf8",
    );

    const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>Realtime Test</title>
        <script>
        ${bundleCode}
        </script>
      </head>
      <body>
        <video id="video" controls></video>
        <script>
          (async () => {
            const videoEl = document.getElementById('video');
            const config = {
              width: 64,
              height: 64,
              frameRate: 5,
              latencyMode: 'realtime',
              videoBitrate: 300000,
              audioBitrate: 64000,
              sampleRate: 48000,
              channels: 1,
              codec: { video: 'avc1.42001E', audio: 'mp4a.40.2' }
            };
            const encoder = new WebCodecsEncoder(config);
            window.chunkCount = 0;
            window.testDone = false;
            const mediaSource = new MediaSource();
            videoEl.src = URL.createObjectURL(mediaSource);
            mediaSource.addEventListener('sourceopen', async () => {
              const sb = mediaSource.addSourceBuffer('video/mp4; codecs="avc1.42001E, mp4a.40.2"');
              sb.mode = 'sequence';
              await encoder.initialize({
                onData: (chunk) => {
                  window.chunkCount++;
                  if (!sb.updating && mediaSource.readyState === 'open') {
                    try { sb.appendBuffer(chunk); } catch (e) { console.error(e); }
                  }
                }
              });
              const canvas = document.createElement('canvas');
              canvas.width = config.width;
              canvas.height = config.height;
              const ctx = canvas.getContext('2d');
              for (let i = 0; i < 5; i++) {
                ctx.fillStyle = 'rgb(' + (i*40) + ',0,0)';
                ctx.fillRect(0,0,canvas.width,canvas.height);
                await encoder.addCanvasFrame(canvas);
              }
              await encoder.finalize();
              setTimeout(() => { window.testDone = true; }, 500);
            });
          })();
        </script>
      </body>
    </html>
    `;

    writeFileSync(htmlPath, htmlContent);

    port = await findAvailablePort(8900);
    server = await startHttpServer(port, distDir);

    browser = await chromium.launch({
      headless: process.env.HEADLESS === "true",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--enable-logging=stderr",
      ],
    });

    page = await browser.newPage();
    await page.goto(`http://localhost:${port}/temp-html/${htmlFilename}`);

    await page.waitForFunction(() => (window as any).testDone === true, {
      timeout: 20000,
    });

    const results = await page.evaluate(() => {
      const video = document.getElementById("video") as HTMLVideoElement;
      return {
        chunks: (window as any).chunkCount as number,
        buffered: video.buffered.length > 0 && video.buffered.end(0) > 0,
      };
    });

    expect(results.chunks).toBeGreaterThan(0);
    expect(results.buffered).toBe(true);
  } finally {
    if (page) await page.close();
    if (browser) await browser.close();
    if (server) server.close();
  }
}, 60000);

/* eslint-enable no-console */
