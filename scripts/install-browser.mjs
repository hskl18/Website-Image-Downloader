import { execFileSync } from "node:child_process";

if (process.env.PUPPETEER_SKIP_DOWNLOAD === "true") {
  console.log("Skipping Puppeteer browser installation.");
} else {
  execFileSync("npx", ["puppeteer", "browsers", "install", "chrome"], {
    stdio: "inherit",
  });
}
