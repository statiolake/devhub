import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const staging = await mkdtemp(resolve(tmpdir(), "devhub-bridge-vsix-"));
const extensionDir = resolve(staging, "extension");
const timestamp = new Date("2000-01-01T00:00:00.000Z");
await mkdir(extensionDir, { recursive: true });
await writeFile(
  resolve(extensionDir, "extension.js"),
  await readFile(resolve(root, "dist/extension.js")),
);
await writeFile(
  resolve(extensionDir, "README.md"),
  await readFile(resolve(root, "README.md")),
);
const manifest = {
  name: "devhub-bridge",
  displayName: packageJson.displayName,
  description: packageJson.description,
  version: packageJson.version,
  publisher: packageJson.publisher,
  license: packageJson.license,
  engines: packageJson.engines,
  main: "./extension.js",
  extensionKind: packageJson.extensionKind,
  activationEvents: packageJson.activationEvents,
  contributes: packageJson.contributes,
};
await writeFile(
  resolve(extensionDir, "package.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await writeFile(
  resolve(staging, "[Content_Types].xml"),
  `<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="xml" ContentType="application/xml"/></Types>\n`,
);
await writeFile(
  resolve(staging, "extension.vsixmanifest"),
  `<?xml version="1.0" encoding="utf-8"?>\n<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema/2011/d"><Metadata><Identity Language="en" Id="devhub.bridge" Version="${packageJson.version}" Publisher="${packageJson.publisher}"/><DisplayName>${packageJson.displayName}</DisplayName><Description xml:space="preserve">${packageJson.description}</Description><Tags>devhub,bridge,openvscode</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${packageJson.engines.vscode}"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" Version="[1.109.0,2.0.0)"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md"/></Assets></PackageManifest>\n`,
);

async function normalize(path) {
  await utimes(path, timestamp, timestamp);
}
for (const path of [
  resolve(staging, "[Content_Types].xml"),
  resolve(staging, "extension.vsixmanifest"),
  resolve(extensionDir, "extension.js"),
  resolve(extensionDir, "README.md"),
  resolve(extensionDir, "package.json"),
])
  await normalize(path);

const outputDir = resolve(root, "build");
await mkdir(outputDir, { recursive: true });
const output = resolve(outputDir, `${manifest.name}-${manifest.version}.vsix`);
await rm(output, { force: true });
const files = [
  "[Content_Types].xml",
  "extension.vsixmanifest",
  "extension/README.md",
  "extension/extension.js",
  "extension/package.json",
];
await new Promise((resolveZip, rejectZip) => {
  const zip = spawn("zip", ["-X", "-q", output, "-@"], {
    cwd: staging,
    env: { ...process.env, TZ: "UTC" },
    stdio: ["pipe", "ignore", "pipe"],
  });
  zip.on("error", rejectZip);
  zip.on("close", (code) =>
    code === 0 ? resolveZip() : rejectZip(new Error("zip failed")),
  );
  zip.stdin.end(`${files.join("\n")}\n`);
});
await rm(staging, { recursive: true, force: true });
console.log(`DevHub Bridge package written: ${output}`);
