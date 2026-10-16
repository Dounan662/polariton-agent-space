# Third-party notices

Polariton-owned source is licensed under [MIT](LICENSE). That license does not
replace the licenses or ownership of third-party components.

| Material | Attribution and license location |
| --- | --- |
| Adapted DeepSeek Harness presentation code | [Origin and modifications](web/src/native/README.md), [MIT notice](web/src/native/LICENSE), and `web/src/native/ORIGIN.json` |
| Adapted DeepSeek Harness MCP client | [MIT notice](harness/native/MCP-LICENSE) and [origin, version and modifications](harness/native/MCP-ORIGIN.json) |
| MCP artwork | [Bundled license](web/src/assets/mcp-LICENSE.txt) |
| Inter font | `@fontsource/inter` package and its bundled license |
| React Flow | `@xyflow/react` package and its bundled license; retain the visible attribution |
| DSH, Cordis, and other installed packages | Their own package licenses; exact versions and integrity hashes are in `package-lock.json` |

[UI origin](docs/UI_ORIGIN.md) records selective reuse and adaptations. The
vendored provenance inventory is checked during the build. Preserve original
copyright notices when modifying or redistributing those files.

Dependencies are downloaded by npm during installation; this source distribution
does not bundle `node_modules`. Any future binary or bundled-dependency release
must also carry the notices required by the material it actually redistributes.
