# BeatBrowser

MCP + Chrome extension so any agent controls **your** signed-in Chrome.

Part of the BeatAPI stack (with BeatDesign).

## Agent setup

If you are an AI agent installing BeatBrowser for a human, follow [`AGENT_INSTALL.md`](./AGENT_INSTALL.md).
Humans: `node src/cli.js doctor` then `node src/cli.js extension` to load the unpacked Chrome extension.

Machine-readable health check:

```bash
node src/cli.js doctor --json
```

## Install

```bash
git clone https://github.com/BeatAPI/beat-browser.git
cd beat-browser
npm install
npx beat-browser install
beat-browser doctor
```

## License

MIT — see [LICENSE](./LICENSE).
