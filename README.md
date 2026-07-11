# Infinite Canvas

A local-first infinite canvas for AI-assisted creative workflows.

Infinite Canvas combines a node-style canvas, reusable cards, AI image generation, agent conversations, prompt libraries, provider management, grouping, and project persistence into a desktop creative workspace.

> Status: early open-source preparation. The core local application exists, while documentation, packaging, tests, and contribution workflows are being improved.

## Features

- Infinite canvas with pan, zoom, card placement, selection, and minimap support.
- Card system for text, image input, AI drawing, agent chat, preview, drawing board, and comparison workflows.
- Connections between cards for visual data-flow style composition.
- Grouping, batch execution, collapse/expand states, and color presets.
- Prompt library for reusable common, skill, and drawing prompts.
- Multi-provider AI model management with OpenAI-compatible endpoints.
- Project save/open support, local snapshots, undo/redo, and clipboard operations.
- TypeScript frontend with Vite and a Python desktop shell powered by pywebview.

## Tech Stack

- Frontend: TypeScript, Vite, Sass/CSS
- Desktop shell: Python, pywebview
- Image and API helpers: Pillow, requests
- Packaging: PyInstaller

## Getting Started

### Prerequisites

- Node.js
- Python 3.10+
- pip

### Install

```bash
npm install
pip install -r requirements.txt
```

### Build the Frontend

```bash
npm run build
```

### Run the Desktop App

```bash
python main.py
```

On first run, the app creates local data files from `_defaults/`.

## Local Configuration

The following files are local runtime data and are intentionally ignored by Git:

- `providers_data.json`
- `settings.json`
- `prompts_library.json`

Do not commit API keys or personal paths. Use the example files in `examples/` as safe templates.

## Development

```bash
npm run typecheck
npm run build
```

The TypeScript migration lives in `src/`. The production desktop shell loads the built frontend from `gui/dist/`.

## Roadmap

- Improve English and Chinese documentation.
- Add screenshots, demos, and example AI workflows.
- Expand automated tests around card contracts, project persistence, and provider configuration.
- Stabilize plugin-style extension points for cards and providers.
- Improve release packaging for Windows and future cross-platform builds.

## Open Source Maintenance

This project is maintained as an open-source AI creative workflow tool. Areas where contributors can help include:

- Bug reports and reproducible examples.
- UI and accessibility polish.
- Card type extensions.
- Provider integrations.
- Documentation and tutorials.
- Test coverage and release automation.

## License

MIT
