# Third-party notices

## pionxzh/chatgpt-exporter

<https://github.com/pionxzh/chatgpt-exporter>. The adapted parts were taken from `master` in October 2026 (userscript v2.38.0).

- `src/core/transcript.js` adapts the exporter's rules for:
  - which conversation messages are part of the visible chat (`processConversation`, `shouldSkipMessageInExport`);
  - how continuation replies are merged;
  - how `content_references` citations and sources footnotes are rendered (`src/utils/citations.ts`).

  The code was rewritten in this project's style; no build-time dependency is used.
- `tests/fixtures/thinking-summaries.json` and `tests/fixtures/image-generation.json` are copied unchanged from that repository's `tests/fixtures/`.

```text
MIT License

Copyright (c) 2022-Present Pionxzh

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
