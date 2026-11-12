import { defineConfig } from "@playwright/test";
const base = process.env.LOOPSTEP_URL ?? "http://127.0.0.1:4190/";
export default defineConfig({
  workers: 1,
  testDir: "tests/browser",
  timeout: 60000,
  use: {
    baseURL: base,
    viewport: { width: 390, height: 844 },
    acceptDownloads: true,
    permissions: ["microphone"],
    launchOptions: {
      args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
  },
  webServer: process.env.LOOPSTEP_URL
    ? undefined
    : {
        command: "npm run build && npx vite preview --host 127.0.0.1 --port 4190 --strictPort",
        url: "http://127.0.0.1:4190/",
        reuseExistingServer: true,
        timeout: 120000,
      },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
