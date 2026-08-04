# mcp-oqmd

OQMD (Open Quantum Materials Database) MCP.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `search_materials` | Search the Open Quantum Materials Database for DFT-computed inorganic materials by composition and/or constituent elements, with optional band-gap and thermodynamic-stability filters. Returns formation energy (eV/atom), energy above the convex hull (stability), band gap, space group, and prototype. Keyless. Provide at least `composition` or `element_set`. |
| `get_material` | Fetch a single OQMD material by its entry_id (e.g. 16525 = the Pbcn polymorph of Fe2O3). Returns formation energy (eV/atom), stability above hull, band gap, space group, prototype, cell volume, atom/element counts, ICSD id, and generic composition. Keyless. |
| `stable_phases` | List the ground-state (on-hull) phases of a chemical system — the thermodynamically stable compounds in OQMD for a given set of elements. e.g. "Fe-O" returns FeO, Fe2O3, Fe3O4. Restricts to materials made ONLY of the given elements with stability <= ~0 (on the convex hull). Keyless. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "oqmd": {
      "url": "https://gateway.pipeworx.io/oqmd/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Oqmd data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
