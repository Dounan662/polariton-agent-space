# UI attribution and provenance

Polariton owns its application shell, graph layout, workspace navigation, and
integration code. Typography uses the pinned Inter font package; React Flow retains
its visible attribution. These dependencies keep their own licenses.

The browser includes an adaptation of DeepSeek Harness conversation, trajectory,
Markdown/math, icons, syntax highlighting, and usage presentation. Its primary
baseline is DSH **0.2.0-rc.2**, revision
`639ed015397290b3745d163aafe02ffee4aa3f84`. Foundational files that were not refreshed
retain revision `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720` in their per-file records.

The [native presentation notes](../web/src/native/README.md) describe the integration.
[ORIGIN.json](../web/src/native/ORIGIN.json) records copied source paths, upstream
revisions, hashes, and local adaptations. The build verifies local hashes. Preserve
that inventory and the [upstream MIT notice](../web/src/native/LICENSE) when editing.

The MCP symbol derives from the Model Context Protocol artwork at revision
`088176704a4e8f20e7f1d237de1de8484aa412fd`: the symbol paths are retained, the wordmark
is removed, and the viewBox is cropped to a square. Its
[license](../web/src/assets/mcp-LICENSE.txt) remains bundled.

See [third-party notices](../THIRD_PARTY_NOTICES.md) for dependency and redistribution
attribution. Private design journals are not needed to build or modify the UI.
