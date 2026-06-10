interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * OQMD (Open Quantum Materials Database) MCP.
 *
 * Keyless DFT-computed thermodynamic and structural properties for ~1M
 * inorganic materials: formation energy, stability (energy above the convex
 * hull), band gap, space group, prototype, cell volume, and ICSD provenance.
 * Backed by oqmd.org/oqmdapi. A live materials-science complement to the
 * Materials Project — no API key required.
 *
 * API quirks (verified live):
 *  - Only `composition=` works as a top-level query param. Everything else
 *    (element_set / band_gap / stability / ntypes) must go through the
 *    OPTIMADE-style `filter=` param using AND + comparison operators
 *    (`band_gap>0.5`, `stability<0.1`). The top-level `composition` param
 *    DOES combine with a `filter=`.
 *  - `entry_id` is NOT a queryable filter property. Single records are fetched
 *    from `GET /entry/{id}/` (trailing slash; redirects without it), where the
 *    id is returned as `id` and formation energy as `formation_energy`.
 */


const BASE = 'https://oqmd.org/oqmdapi';
const UA = 'pipeworx/1.0 (+https://pipeworx.io)';

// Fields requested on the /formationenergy collection endpoint. Always sent to
// keep payloads small (OQMD can be slow).
const SEARCH_FIELDS = 'name,entry_id,spacegroup,delta_e,band_gap,stability,prototype,ntypes,volume';

const tools: McpToolExport['tools'] = [
  {
    name: 'search_materials',
    description:
      "Search the Open Quantum Materials Database for DFT-computed inorganic materials by composition and/or constituent elements, with optional band-gap and thermodynamic-stability filters. Returns formation energy (eV/atom), energy above the convex hull (stability), band gap, space group, and prototype. Keyless. Provide at least `composition` or `element_set`.",
    inputSchema: {
      type: 'object',
      properties: {
        composition: {
          type: 'string',
          description: 'Exact composition, e.g. "Fe2O3", "LiCoO2". Matched as an exact stoichiometry.',
        },
        element_set: {
          type: 'string',
          description:
            'Constituent elements the material must contain. Use OQMD set syntax: "(Al-O)" = contains Al or O; "(Fe-O),Ni" = (Fe or O) and Ni. A plain comma list like "Fe,O" is also accepted.',
        },
        band_gap_min: {
          type: 'number',
          description: 'Minimum band gap in eV (exclusive). e.g. 0.5 to find semiconductors/insulators.',
        },
        max_stability: {
          type: 'number',
          description:
            'Maximum energy above the convex hull in eV/atom (exclusive). 0 = exactly on the hull (thermodynamically stable / ground state). e.g. 0.05 keeps near-stable phases.',
        },
        limit: { type: 'number', description: 'Max results, default 10, max 25.' },
      },
    },
  },
  {
    name: 'get_material',
    description:
      "Fetch a single OQMD material by its entry_id (e.g. 16525 = the Pbcn polymorph of Fe2O3). Returns formation energy (eV/atom), stability above hull, band gap, space group, prototype, cell volume, atom/element counts, ICSD id, and generic composition. Keyless.",
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: {
          type: 'number',
          description: 'OQMD entry_id, e.g. 16525 (Fe2O3, Pbcn). Get ids from search_materials results.',
        },
      },
      required: ['entry_id'],
    },
  },
  {
    name: 'stable_phases',
    description:
      "List the ground-state (on-hull) phases of a chemical system — the thermodynamically stable compounds in OQMD for a given set of elements. e.g. \"Fe-O\" returns FeO, Fe2O3, Fe3O4. Restricts to materials made ONLY of the given elements with stability <= ~0 (on the convex hull). Keyless.",
    inputSchema: {
      type: 'object',
      properties: {
        elements: {
          type: 'string',
          description: 'A chemical system as dash- or comma-separated elements, e.g. "Fe-O", "Li-Fe-O", "Al,O".',
        },
        limit: { type: 'number', description: 'Max phases, default 15, max 30.' },
      },
      required: ['elements'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'search_materials':
        return searchMaterials(args);
      case 'get_material':
        return getMaterial(args);
      case 'stable_phases':
        return stablePhases(args);
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function round(n: unknown, d: number): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/** GET the /formationenergy collection with arbitrary query params. */
async function oqmdGet(params: Record<string, string>): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}/formationenergy?${qs}`, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
  });
  if (!res.ok) {
    throw new Error(`oqmd: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

/** Map a raw /formationenergy record (uses delta_e) to the compact shape. */
function mapMaterial(raw: Record<string, unknown>): Record<string, unknown> {
  const stability = round(raw.stability, 3);
  return {
    name: raw.name,
    entry_id: raw.entry_id,
    spacegroup: raw.spacegroup,
    formation_energy_ev_atom: round(raw.delta_e, 3),
    band_gap_ev: round(raw.band_gap, 3),
    stability_ev_atom: stability,
    is_stable: typeof raw.stability === 'number' ? raw.stability <= 0 : null,
    prototype: raw.prototype,
    n_element_types: raw.ntypes,
  };
}

// ── tools ──────────────────────────────────────────────────────────────────

async function searchMaterials(args: Record<string, unknown>): Promise<unknown> {
  const composition = typeof args.composition === 'string' ? args.composition.trim() : '';
  const elementSet = typeof args.element_set === 'string' ? args.element_set.trim() : '';
  if (!composition && !elementSet) {
    return { error: 'provide at least composition or element_set' };
  }

  const limit = Math.min(Math.max(Math.trunc(Number(args.limit) || 10), 1), 25);

  // Only `composition` is a top-level param; the rest go through `filter=`.
  const params: Record<string, string> = { fields: SEARCH_FIELDS, limit: String(limit) };
  if (composition) params.composition = composition;

  const filters: string[] = [];
  if (elementSet) filters.push(`element_set=${elementSet}`);
  if (typeof args.band_gap_min === 'number' && Number.isFinite(args.band_gap_min)) {
    filters.push(`band_gap>${args.band_gap_min}`);
  }
  if (typeof args.max_stability === 'number' && Number.isFinite(args.max_stability)) {
    filters.push(`stability<${args.max_stability}`);
  }
  if (filters.length) params.filter = filters.join(' AND ');

  const body = await oqmdGet(params);
  const data = Array.isArray(body.data) ? (body.data as Array<Record<string, unknown>>) : [];
  const meta = (body.meta as Record<string, unknown> | undefined) ?? {};

  return {
    count: data.length,
    more_available: Boolean(meta.more_data_available),
    materials: data.map(mapMaterial),
  };
}

async function getMaterial(args: Record<string, unknown>): Promise<unknown> {
  const entryId = Math.trunc(Number(args.entry_id));
  if (!Number.isFinite(entryId) || entryId <= 0) {
    return { error: 'provide a valid numeric entry_id', entry_id: args.entry_id ?? null };
  }

  // Single records live at /entry/{id}/ (trailing slash). entry_id is not a
  // queryable filter on the collection endpoint.
  const res = await fetch(`${BASE}/entry/${entryId}/`, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
  });
  if (res.status === 404) return { error: 'entry not found', entry_id: entryId };
  if (!res.ok) return { error: `oqmd: ${res.status} ${(await res.text()).slice(0, 200)}` };

  const raw = (await res.json()) as Record<string, unknown>;
  if (!raw || (raw.id == null && raw.name == null)) {
    return { error: 'entry not found', entry_id: entryId };
  }

  const stability = round(raw.stability, 3);
  return {
    name: raw.name,
    entry_id: raw.id ?? entryId, // /entry/{id} returns the id as `id`
    spacegroup: raw.spacegroup,
    // /entry/{id} exposes formation energy as `formation_energy` (eV/atom).
    formation_energy_ev_atom: round(raw.formation_energy ?? raw.delta_e, 3),
    band_gap_ev: round(raw.band_gap, 3),
    stability_ev_atom: stability,
    is_stable: typeof raw.stability === 'number' ? raw.stability <= 0 : null,
    prototype: raw.prototype,
    volume: round(raw.volume, 3),
    natoms: raw.natoms,
    ntypes: raw.ntypes,
    icsd_id: raw.icsd_id,
    composition_generic: raw.composition_generic,
  };
}

async function stablePhases(args: Record<string, unknown>): Promise<unknown> {
  const elementsRaw = typeof args.elements === 'string' ? args.elements.trim() : '';
  if (!elementsRaw) return { error: 'provide a chemical system, e.g. "Fe-O"' };

  const elements = elementsRaw
    .split(/[-,\s]+/)
    .map((e) => e.trim())
    .filter(Boolean);
  if (!elements.length) return { error: 'could not parse elements', elements: elementsRaw };

  const limit = Math.min(Math.max(Math.trunc(Number(args.limit) || 15), 1), 30);
  const system = elements.join('-');

  // Strict system: only these elements (ntypes == count) AND each present,
  // restricted to on-hull phases (stability ~ 0).
  const filter =
    `ntypes=${elements.length} AND ` +
    elements.map((e) => `element_set=${e}`).join(' AND ') +
    ` AND stability<0.001`;

  const body = await oqmdGet({ filter, fields: SEARCH_FIELDS, limit: String(limit) });
  const data = Array.isArray(body.data) ? (body.data as Array<Record<string, unknown>>) : [];

  const phases = data
    .map((raw) => ({
      name: raw.name,
      entry_id: raw.entry_id,
      spacegroup: raw.spacegroup,
      formation_energy_ev_atom: round(raw.delta_e, 3),
      band_gap_ev: round(raw.band_gap, 3),
    }))
    .sort((a, b) => {
      const av = a.formation_energy_ev_atom ?? Infinity;
      const bv = b.formation_energy_ev_atom ?? Infinity;
      return av - bv; // most stable (most negative) first
    });

  return { system, count: phases.length, stable_phases: phases };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
