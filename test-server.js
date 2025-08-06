// Simple test server to verify the app works
const { spawn } = require("child_process");

console.log("🚀 Starting Next.js development server...");

const server = spawn("npm", ["run", "dev"], {
  stdio: "inherit",
  shell: true,
});

server.on("close", (code) => {
  console.log(`Server exited with code ${code}`);
});

// Handle Ctrl+C
process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down server...");
  server.kill("SIGINT");
  process.exit(0);
});
